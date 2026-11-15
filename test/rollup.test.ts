import path from 'node:path';
import { rollup, VERSION, type OutputOptions, type Plugin } from 'rollup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugSplatOptions } from '../src/options.js';
import rollupPlugin from '../src/rollup.js';
import { uploadWithSymbolUpload } from '../src/symbol-upload.js';
import vitePlugin from '../src/vite.js';
import {
  createTestLogger,
  debugIdsByName,
  expectDebugId,
  expectRegistration,
  expectTokenMapsToSource,
  fakeUpload,
  fixtureRoot,
  outputDirectory,
  readBuiltFiles,
  type BuiltFile,
} from './helpers.js';

const upload = vi.mocked(uploadWithSymbolUpload);

// The Vite entry point has to work in a plain Rollup config too.
describe.each([
  { entry: '@bugsplat/build/rollup', bugsplat: rollupPlugin as (options?: BugSplatOptions) => unknown },
  { entry: '@bugsplat/build/vite', bugsplat: vitePlugin as (options?: BugSplatOptions) => unknown },
])(`Rollup ${VERSION} with $entry`, ({ entry, bugsplat }) => {
  const prefix = entry.endsWith('vite') ? 'rollup-vite-entry' : 'rollup';
  const lines = () => logged.lines.map((line) => `${line.level}: ${line.message}`);
  let logged = createTestLogger();

  beforeEach(() => {
    logged = createTestLogger();
    upload.mockReset();
    upload.mockImplementation(fakeUpload);
  });

  async function build(
    name: string,
    plugin: BugSplatOptions | false = {},
    outputs: (outDir: string) => OutputOptions[] = (outDir) => [{ dir: outDir, format: 'es', sourcemap: true }],
    { input = 'main.js', laterPlugins = [] as Plugin[] } = {},
  ): Promise<{ outDir: string; files: BuiltFile[] }> {
    const outDir = outputDirectory(`${prefix}-${name}`);
    const warnings: string[] = [];
    const bundle = await rollup({
      input: path.join(fixtureRoot, 'src', input),
      plugins: [...(plugin === false ? [] : [bugsplat({ logger: logged.logger, ...plugin }) as Plugin]), ...laterPlugins],
      onwarn: (warning) => warnings.push(warning.message),
    });
    try {
      for (const output of outputs(outDir)) {
        await bundle.write(output);
      }
    } finally {
      await bundle.close();
    }
    // Rollup warns about unknown plugin hooks and unknown output options.
    expect(warnings).toEqual([]);
    return { outDir, files: readBuiltFiles(outDir) };
  }

  it('writes one debug ID to every JavaScript file and its source map, and registers it', async () => {
    const { files } = await build('ids');

    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const built of files) {
      expectRegistration(built, expectDebugId(built), 'module');
    }
    expectTokenMapsToSource(files, 'lazy-boom-token', 'lazy.js');
    expectTokenMapsToSource(files, 'entry-greeting-token', 'main.js');
  });

  it("uses Rollup's own debug IDs, and the same ones in two identical builds", async () => {
    const withoutPlugin = await build('native-reference', false, (outDir) => [
      { dir: outDir, format: 'es', sourcemap: true, sourcemapDebugIds: true },
    ]);
    const first = await build('native-1');
    const second = await build('native-2');

    expect(debugIdsByName(first.files)).toEqual(debugIdsByName(withoutPlugin.files));
    expect(debugIdsByName(second.files)).toEqual(debugIdsByName(first.files));
  });

  it('derives the same IDs in two identical builds when Rollup writes none', async () => {
    const outputs = (outDir: string): OutputOptions[] => [
      { dir: outDir, format: 'es', sourcemap: true, sourcemapDebugIds: false },
    ];
    const first = await build('derived-1', {}, outputs);
    const second = await build('derived-2', {}, outputs);

    first.files.forEach((built) => expectDebugId(built));
    expect(debugIdsByName(second.files)).toEqual(debugIdsByName(first.files));
  });

  it('replaces process.env.BUGSPLAT_DATABASE without disturbing the rest of the line in the source map', async () => {
    const { files } = await build('inline', { database: 'fred-option' });

    const code = files.map((built) => built.code).join('\n');
    expect(code).toContain('describeDatabase("fred-option", \'after-database-token\')');
    expect(code).not.toContain('process.env.BUGSPLAT_DATABASE');
    expectTokenMapsToSource(files, 'after-database-token', 'main.js');
  });

  it('replaces only reads of process.env.BUGSPLAT_DATABASE, not strings, comments or assignment targets', async () => {
    const { files } = await build('inline-syntax', { database: 'fred-option' }, undefined, {
      input: 'database-expression.js',
    });

    const lines = files[0]!.code.split('\n').map((line) => line.trim());
    expect(lines).toEqual(
      expect.arrayContaining([
        '// process.env.BUGSPLAT_DATABASE is text or something that is written to.',
        'const label = "process.env.BUGSPLAT_DATABASE";',
        "const template = `€ ${'process.env.BUGSPLAT_DATABASE'} process.env.BUGSPLAT_DATABASE`;",
        'process.env.BUGSPLAT_DATABASE = value;',
        '[process.env.BUGSPLAT_DATABASE] = [value];',
        '({ value: process.env.BUGSPLAT_DATABASE } = { value });',
        'delete process.env.BUGSPLAT_DATABASE;',
        'const database = /* 😀 */ "fred-option";',
        'const settings = { database: "fred-option", length: "fred-option".length };',
      ]),
    );
    expect(files[0]!.code.split('fred-option')).toHaveLength(4);
  });

  it('replaces process.env.BUGSPLAT_DATABASE in a module that a later plugin compiles to JavaScript', async () => {
    const stripTypes: Plugin = {
      name: 'strip-types',
      transform: (code, id) => (id.endsWith('.ts') ? { code: code.replace(': string', ''), map: { mappings: '' } } : null),
    };
    const { files } = await build('inline-typescript', { database: 'fred-option' }, undefined, {
      input: 'database-expression.ts',
      laterPlugins: [stripTypes],
    });

    expect(files[0]!.code).toContain('const database = "fred-option";');
  });

  it('leaves process.env.BUGSPLAT_DATABASE alone when inlineDatabase is off', async () => {
    const { files } = await build('inline-off', { database: 'fred-option', inlineDatabase: false });

    expect(files.map((built) => built.code).join('\n')).toContain('process.env.BUGSPLAT_DATABASE');
  });

  it('handles every output of a build, whether it names a directory or a file', async () => {
    const { outDir, files } = await build(
      'outputs',
      { database: 'fred', clientId: 'client-id', clientSecret: 'client-secret' },
      (dir) => [
        { dir: path.join(dir, 'es'), format: 'es', sourcemap: true },
        { file: path.join(dir, 'cjs', 'bundle.cjs'), format: 'cjs', sourcemap: 'hidden', inlineDynamicImports: true },
      ],
    );

    expect(files.map((built) => built.name)).toContain('cjs/bundle.cjs');
    expect(files.filter((built) => built.name.startsWith('es/')).length).toBeGreaterThanOrEqual(2);
    for (const built of files) {
      expectRegistration(built, expectDebugId(built), built.name.endsWith('.cjs') ? 'commonjs' : 'module');
    }
    expect(upload.mock.calls.map(([request]) => request.directory)).toEqual([
      path.join(outDir, 'es'),
      path.join(outDir, 'cjs'),
    ]);
    expect(upload.mock.calls[0]![0]).toEqual({
      database: 'fred',
      // Plain Rollup has no project root, so package.json is found from the working directory.
      application: '@bugsplat/build',
      version: expect.any(String) as string,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      directory: path.join(outDir, 'es'),
      files: ['**/*.map'],
    });
  });

  it('skips the upload with one log line when credentials are absent', async () => {
    await build('upload-skipped');

    expect(upload).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      'info: Source maps were not uploaded: missing database (BUGSPLAT_DATABASE), clientId (SYMBOL_UPLOAD_CLIENT_ID), clientSecret (SYMBOL_UPLOAD_CLIENT_SECRET).',
    ]);
  });

  it('fails the build when the upload fails and failOnError is set', async () => {
    upload.mockRejectedValue(new Error('401 Unauthorized'));

    await expect(
      build('fail-on-error', { database: 'fred', clientId: 'id', clientSecret: 'secret', failOnError: true }),
    ).rejects.toThrow(/Source map upload failed: 401 Unauthorized/);
  });
});
