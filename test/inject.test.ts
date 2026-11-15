import { describe, expect, it } from 'vitest';
import { createRegistrationSnippet, deriveDebugId, normaliseDebugId } from '../src/debug-id.js';
import { injectDebugId } from '../src/inject.js';

const map = JSON.stringify({ version: 3, file: 'app.js', sources: ['app.ts'], names: [], mappings: 'AAAA' });
const nativeId = '9f2c1a7e-3b4d-4c5e-8f60-112233445566';

describe('normaliseDebugId', () => {
  it('lowercases and removes hyphens', () => {
    expect(normaliseDebugId('9F2C1A7E-3B4D-4C5E-8F60-112233445566')).toBe('9f2c1a7e3b4d4c5e8f60112233445566');
    expect(normaliseDebugId('9f2c1a7e3b4d4c5e8f60112233445566')).toBe('9f2c1a7e3b4d4c5e8f60112233445566');
  });

  it('treats anything that is not 32 hex characters as no ID', () => {
    for (const value of ['', 'abc', '9f2c1a7e-3b4d-4c5e-8f60-11223344556', `${nativeId}0`, 'z'.repeat(32), 42, null, undefined]) {
      expect(normaliseDebugId(value)).toBeUndefined();
    }
  });
});

describe('deriveDebugId', () => {
  it('gives the same canonical UUID for the same content', () => {
    const id = deriveDebugId('code', 'map');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveDebugId('code', 'map')).toBe(id);
  });

  it('gives different IDs for different content', () => {
    const ids = [deriveDebugId('code', 'map'), deriveDebugId('code2', 'map'), deriveDebugId('code', 'map2'), deriveDebugId('cod', 'emap')];
    expect(new Set(ids).size).toBe(4);
  });
});

describe('createRegistrationSnippet', () => {
  it('is the snippet from the debug ID contract', () => {
    expect(createRegistrationSnippet(nativeId)).toBe(
      ';!function(){try{var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof global?global:self,n=(new e.Error).stack;n&&(e._debugIds=e._debugIds||{},e._debugIds[n]="9f2c1a7e-3b4d-4c5e-8f60-112233445566")}catch(e){}}();',
    );
  });
});

describe('injectDebugId', () => {
  it('derives an ID and adds the snippet, the comment and the map field', () => {
    const code = 'console.log(1);\n//# sourceMappingURL=app.js.map';
    const result = injectDebugId(code, map);

    expect(result.origin).toBe('derived');
    expect(result.changed).toBe(true);
    expect(result.debugId).toBe(deriveDebugId('console.log(1);', map));
    expect(result.code).toBe(
      [
        'console.log(1);',
        createRegistrationSnippet(result.debugId),
        `//# debugId=${result.debugId}`,
        '//# sourceMappingURL=app.js.map',
      ].join('\n'),
    );
    expect(JSON.parse(result.map)).toEqual({ ...JSON.parse(map), debugId: result.debugId });
    // debugId is the last key, where magic-string and the bundlers put it.
    expect(result.map.endsWith(`,"debugId":"${result.debugId}"}`)).toBe(true);
  });

  it('changes nothing the second time', () => {
    const first = injectDebugId('console.log(1);\n//# sourceMappingURL=app.js.map\n', map);
    const second = injectDebugId(first.code, first.map);

    expect(second.changed).toBe(false);
    expect(second.code).toBe(first.code);
    expect(second.map).toBe(first.map);
    expect(second.debugId).toBe(first.debugId);
    expect(second.origin).toBe('comment');
  });

  it('never inserts anything before or inside the existing code', () => {
    const code = 'line1();\nline2();\n//# sourceMappingURL=app.js.map\n';
    const result = injectDebugId(code, map);

    expect(result.code.startsWith('line1();\nline2();\n;!function')).toBe(true);
    expect(JSON.parse(result.map).mappings).toBe('AAAA');
  });

  it('keeps the final line break of the file as it was', () => {
    expect(injectDebugId('a();\n//# sourceMappingURL=app.js.map\n', map).code.endsWith('.map\n')).toBe(true);
    expect(injectDebugId('a();\n//# sourceMappingURL=app.js.map', map).code.endsWith('.map')).toBe(true);
  });

  it('puts the snippet on its own line, so a trailing line comment cannot swallow it', () => {
    const result = injectDebugId('a(); // done', map);

    expect(result.code.split('\n')).toEqual([
      'a(); // done',
      createRegistrationSnippet(result.debugId),
      `//# debugId=${result.debugId}`,
    ]);
  });

  it("uses the ID in the file's debugId comment", () => {
    const code = `a();\n//# debugId=${nativeId}\n//# sourceMappingURL=app.js.map\n`;
    const result = injectDebugId(code, map);

    expect(result.origin).toBe('comment');
    expect(result.debugId).toBe(nativeId);
    expect(result.code).toBe(
      `a();\n${createRegistrationSnippet(nativeId)}\n//# debugId=${nativeId}\n//# sourceMappingURL=app.js.map\n`,
    );
    expect(JSON.parse(result.map).debugId).toBe(nativeId);
  });

  it('leaves a source map alone when it already has the same ID', () => {
    const mapWithId = JSON.stringify({ version: 3, debugId: nativeId, mappings: 'AAAA' }, null, 2);
    const result = injectDebugId(`a();\n//# debugId=${nativeId}\n`, mapWithId);

    expect(result.map).toBe(mapWithId);
  });

  it('moves a debugId comment that sits below sourceMappingURL above it', () => {
    const code = `a();\n//# sourceMappingURL=app.js.map\n//# debugId=${nativeId}`;

    expect(injectDebugId(code, map).code).toBe(
      `a();\n${createRegistrationSnippet(nativeId)}\n//# debugId=${nativeId}\n//# sourceMappingURL=app.js.map`,
    );
  });

  it('accepts an ID written as 32 hex characters and keeps it as written', () => {
    const bunId = '9F2C1A7E3B4D4C5E8F60112233445566';
    const result = injectDebugId(`a();\n//# debugId=${bunId}\n`, map);

    expect(result.debugId).toBe(bunId);
    expect(result.code).toContain(`_debugIds[n]="${bunId}"`);
    expect(JSON.parse(result.map).debugId).toBe(bunId);
  });

  it('uses the ID in the source map when the file has no comment', () => {
    const mapWithId = JSON.stringify({ version: 3, mappings: 'AAAA', debugId: nativeId });
    const result = injectDebugId('a();', mapWithId);

    expect(result.origin).toBe('map');
    expect(result.code).toBe(`a();\n${createRegistrationSnippet(nativeId)}\n//# debugId=${nativeId}`);
    expect(result.map).toBe(mapWithId);
  });

  it('accepts debug_id in the source map and adds debugId next to it', () => {
    const result = injectDebugId('a();', JSON.stringify({ version: 3, mappings: 'AAAA', debug_id: nativeId }));

    expect(result.origin).toBe('map');
    expect(JSON.parse(result.map)).toEqual({ version: 3, mappings: 'AAAA', debug_id: nativeId, debugId: nativeId });
  });

  it("makes the source map agree with the file's comment when they differ", () => {
    const other = '00000000-0000-4000-8000-000000000000';
    const result = injectDebugId(`a();\n//# debugId=${nativeId}`, JSON.stringify({ version: 3, debugId: other }));

    expect(result.debugId).toBe(nativeId);
    expect(JSON.parse(result.map).debugId).toBe(nativeId);
  });

  it('replaces an invalid debugId comment', () => {
    const result = injectDebugId('a();\n//# debugId=not-an-id\n//# sourceMappingURL=app.js.map', map);

    expect(result.origin).toBe('derived');
    expect(result.code.match(/\/\/# debugId=/g)).toHaveLength(1);
    expect(result.code).not.toContain('not-an-id');
  });

  it('finds a debugId comment that is followed by a footer, without moving any line', () => {
    // A bundler that writes the comment writes the same ID to the source map.
    const mapWithId = JSON.stringify({ ...JSON.parse(map), debugId: nativeId });
    const code = `a();\n//# debugId=${nativeId}\n/* footer */\n//# sourceMappingURL=app.js.map`;
    const result = injectDebugId(code, mapWithId);

    expect(result.origin).toBe('comment');
    expect(result.code.split('\n')).toEqual([
      'a();',
      '',
      '/* footer */',
      createRegistrationSnippet(nativeId),
      `//# debugId=${nativeId}`,
      '//# sourceMappingURL=app.js.map',
    ]);
    expect(injectDebugId(result.code, result.map).changed).toBe(false);
  });

  it('leaves a line that looks like a debugId comment inside a template literal as it is', () => {
    const body = `const text = \`\n//# debugId=${nativeId}\n\`;\nexport { text };`;
    const code = `${body}\n//# sourceMappingURL=app.js.map`;
    const otherId = '00000000-0000-4000-8000-000000000000';

    for (const [sourceMap, origin] of [
      [map, 'derived'],
      [JSON.stringify({ ...JSON.parse(map), debugId: otherId }), 'map'],
    ] as const) {
      const result = injectDebugId(code, sourceMap);

      // The text of the string is untouched, and its ID is not taken for the file's own.
      expect(result.origin).toBe(origin);
      expect(result.debugId).not.toBe(nativeId);
      expect(result.code).toBe(
        `${body}\n${createRegistrationSnippet(result.debugId)}\n//# debugId=${result.debugId}\n//# sourceMappingURL=app.js.map`,
      );
      expect(injectDebugId(result.code, result.map).changed).toBe(false);
    }
  });

  it('corrects a trailing snippet that registers a different ID', () => {
    const stale = createRegistrationSnippet('00000000-0000-4000-8000-000000000000');
    const result = injectDebugId(`a();\n${stale}\n//# debugId=${nativeId}`, map);

    expect(result.code).toBe(`a();\n${createRegistrationSnippet(nativeId)}\n//# debugId=${nativeId}`);
  });

  it('keeps the ID of a trailing snippet whose comment was stripped', () => {
    const result = injectDebugId(`a();\n${createRegistrationSnippet(nativeId)}`, map);

    expect(result.origin).toBe('snippet');
    expect(result.code).toBe(`a();\n${createRegistrationSnippet(nativeId)}\n//# debugId=${nativeId}`);
  });

  it("does not mistake a bundled dependency's snippet in the middle of the code for its own", () => {
    const dependency = createRegistrationSnippet('00000000-0000-4000-8000-000000000000');
    const result = injectDebugId(`${dependency}\na();`, map);

    expect(result.origin).toBe('derived');
    expect(result.code.split('\n')).toEqual([
      dependency,
      'a();',
      createRegistrationSnippet(result.debugId),
      `//# debugId=${result.debugId}`,
    ]);
  });

  it('handles Windows line endings', () => {
    const result = injectDebugId('a();\r\n//# sourceMappingURL=app.js.map\r\n', map);

    expect(result.code).toBe(
      `a();\n${createRegistrationSnippet(result.debugId)}\n//# debugId=${result.debugId}\n//# sourceMappingURL=app.js.map\n`,
    );
  });

  it('puts debugId at the top level of an index map and leaves its sections alone', () => {
    const sections = [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' } },
      { offset: { line: 1, column: 0 }, map: { version: 3, sources: ['b.ts'], names: [], mappings: 'AAAA' } },
    ];
    const result = injectDebugId('a();\nb();\n//# sourceMappingURL=app.js.map', JSON.stringify({ version: 3, sections }));

    expect(JSON.parse(result.map)).toEqual({ version: 3, sections, debugId: result.debugId });
    // The snippet is on line 2 (0-based), after every section's code.
    expect(result.code.split('\n').indexOf(createRegistrationSnippet(result.debugId))).toBe(2);
  });

  it('handles a file with no code', () => {
    const result = injectDebugId('', map);

    expect(result.code).toBe(`${createRegistrationSnippet(result.debugId)}\n//# debugId=${result.debugId}`);
  });

  it('throws when the source map is not a JSON object', () => {
    expect(() => injectDebugId('a();', 'not json')).toThrow(SyntaxError);
    expect(() => injectDebugId('a();', '[]')).toThrow(SyntaxError);
  });
});
