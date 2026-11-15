import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistrationSnippet } from '../src/debug-id.js';
import { injectDebugIdIntoFile, injectDebugIdsIntoDirectory } from '../src/fs.js';
import { outputDirectory } from './helpers.js';

const map = JSON.stringify({ version: 3, sources: ['app.ts'], names: [], mappings: 'AAAA' });

function write(directory: string, name: string, content: string): string {
  const file = path.join(directory, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe('injectDebugIdIntoFile', () => {
  it('rewrites the JavaScript file and the source map named by its sourceMappingURL comment', async () => {
    const directory = outputDirectory('fs-file');
    const file = write(directory, 'js/app.js', 'a();\n//# sourceMappingURL=../maps/app.js.map?v=1\n');
    const mapFile = write(directory, 'maps/app.js.map', map);

    const result = await injectDebugIdIntoFile(file);

    expect(result).toEqual({ file, mapFile, debugId: result.debugId, origin: 'derived', changed: true });
    expect(readFileSync(file, 'utf8')).toBe(
      `a();\n${createRegistrationSnippet(result.debugId!)}\n//# debugId=${result.debugId}\n//# sourceMappingURL=../maps/app.js.map?v=1\n`,
    );
    expect(JSON.parse(readFileSync(mapFile, 'utf8')).debugId).toBe(result.debugId);
  });

  it('falls back to <file>.map for hidden source maps and absolute sourceMappingURLs', async () => {
    const directory = outputDirectory('fs-hidden');
    const hidden = write(directory, 'hidden.js', 'a();');
    write(directory, 'hidden.js.map', map);
    const absolute = write(directory, 'absolute.js', 'a();\n//# sourceMappingURL=https://cdn.example.com/absolute.js.map');
    write(directory, 'absolute.js.map', map);

    expect((await injectDebugIdIntoFile(hidden)).mapFile).toBe(`${hidden}.map`);
    expect((await injectDebugIdIntoFile(absolute)).mapFile).toBe(`${absolute}.map`);
    expect(readFileSync(absolute, 'utf8')).toMatch(/\n\/\/# sourceMappingURL=https:\/\/cdn\.example\.com\/absolute\.js\.map$/);
  });

  it('does not write files that are already complete', async () => {
    const directory = outputDirectory('fs-idempotent');
    const file = write(directory, 'app.js', 'a();\n//# sourceMappingURL=app.js.map');
    write(directory, 'app.js.map', map);
    await injectDebugIdIntoFile(file);
    const longAgo = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, longAgo, longAgo);
    utimesSync(`${file}.map`, longAgo, longAgo);

    const result = await injectDebugIdIntoFile(file);

    expect(result.changed).toBe(false);
    expect(statSync(file).mtime).toEqual(longAgo);
    expect(statSync(`${file}.map`).mtime).toEqual(longAgo);
  });

  it('skips a file with no source map file, including one with an inline source map', async () => {
    const directory = outputDirectory('fs-skip');
    const plain = write(directory, 'plain.js', 'a();');
    const inline = write(directory, 'inline.js', 'a();\n//# sourceMappingURL=data:application/json;base64,e30=');

    expect(await injectDebugIdIntoFile(plain)).toEqual({ file: plain, changed: false, skipped: 'no-source-map' });
    expect(await injectDebugIdIntoFile(inline)).toEqual({ file: inline, changed: false, skipped: 'no-source-map' });
    expect(readFileSync(plain, 'utf8')).toBe('a();');
    expect(readFileSync(inline, 'utf8')).toBe('a();\n//# sourceMappingURL=data:application/json;base64,e30=');
  });

  it('skips a file whose source map is not JSON', async () => {
    const directory = outputDirectory('fs-invalid');
    const file = write(directory, 'app.js', 'a();');
    const mapFile = write(directory, 'app.js.map', 'not json');

    expect(await injectDebugIdIntoFile(file)).toEqual({ file, mapFile, changed: false, skipped: 'invalid-source-map' });
    expect(readFileSync(file, 'utf8')).toBe('a();');
  });
});

describe('injectDebugIdsIntoDirectory', () => {
  it('handles every .js, .mjs and .cjs file below the directory except node_modules and dot-folders', async () => {
    const directory = outputDirectory('fs-directory');
    for (const name of ['a.js', 'nested/b.mjs', 'nested/deeper/c.cjs', 'node_modules/dep/d.js', '.cache/e.js']) {
      write(directory, name, `${name}();`);
      write(directory, `${name}.map`, map);
    }
    write(directory, 'no-map.js', 'a();');
    write(directory, 'style.css', 'a{}');
    write(directory, 'style.css.map', map);

    const results = await injectDebugIdsIntoDirectory(directory);

    expect(results.map((result) => [path.relative(directory, result.file), result.changed, result.skipped])).toEqual([
      ['a.js', true, undefined],
      [path.join('nested', 'b.mjs'), true, undefined],
      [path.join('nested', 'deeper', 'c.cjs'), true, undefined],
      ['no-map.js', false, 'no-source-map'],
    ]);
    expect(new Set(results.map((result) => result.debugId)).size).toBe(4);
    expect(readFileSync(path.join(directory, 'node_modules/dep/d.js'), 'utf8')).toBe('node_modules/dep/d.js();');
    expect(readFileSync(path.join(directory, 'style.css.map'), 'utf8')).toBe(map);
    expect((await injectDebugIdsIntoDirectory(directory)).some((result) => result.changed)).toBe(false);
  });

  it('resolves with nothing for a directory that does not exist', async () => {
    expect(await injectDebugIdsIntoDirectory(path.join(outputDirectory('fs-missing'), 'nope'))).toEqual([]);
  });
});
