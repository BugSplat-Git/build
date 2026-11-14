import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugSplatOptions } from '../src/options.js';
import { uploadWithSymbolUpload } from '../src/symbol-upload.js';
import bugsplat from '../src/vite.js';
import {
  createTestLogger,
  debugIdsByName,
  expectDebugId,
  expectRegistration,
  expectTokenMapsToSource,
  fixtureRoot,
  listSourceMaps,
  outputDirectory,
  readBuiltFiles,
  type BuiltFile,
} from './helpers.js';

const upload = vi.mocked(uploadWithSymbolUpload);

interface BuildSettings {
  /** Options for the plugin; `false` builds without it. */
  plugin?: BugSplatOptions | false;
  /** Rollup/Rolldown output options, such as `sourcemapDebugIds`. */
  output?: Record<string, unknown>;
  sourcemap?: boolean | 'hidden' | 'inline';
  extraPlugins?: unknown[];
}

// The current major (Rolldown) and the two before it (Rollup).
describe.each([
  { moduleName: 'vite', major: 8 },
  { moduleName: 'vite7', major: 7 },
  { moduleName: 'vite6', major: 6 },
])('Vite $major', ({ moduleName, major }) => {
  const lines = () => logged.lines.map((line) => `${line.level}: ${line.message}`);
  let logged = createTestLogger();

  beforeEach(() => {
    logged = createTestLogger();
    upload.mockReset();
    upload.mockResolvedValue(undefined);
  });

  async function build(name: string, settings: BuildSettings = {}): Promise<{ outDir: string; files: BuiltFile[] }> {
    const vite = (await import(moduleName)) as typeof import('vite');
    expect(vite.version.split('.')[0]).toBe(String(major));
    const outDir = outputDirectory(`vite${major}-${name}`);
    const plugins: unknown[] = [];
    if (settings.plugin !== false) {
      plugins.push(bugsplat({ logger: logged.logger, ...settings.plugin }));
    }
    plugins.push(...(settings.extraPlugins ?? []));
    await vite.build({
      root: fixtureRoot,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      plugins: plugins as import('vite').PluginOption[],
      build: {
        outDir,
        emptyOutDir: true,
        sourcemap: settings.sourcemap ?? true,
        minify: true,
        // The polyfill touches `document` when the entry loads, which the tests' Node process lacks.
        modulePreload: { polyfill: false },
        [major >= 8 ? 'rolldownOptions' : 'rollupOptions']: { output: settings.output ?? {} },
      },
    });
    return { outDir, files: readBuiltFiles(outDir) };
  }

  it('writes one debug ID to every JavaScript file and its source map', async () => {
    const { files } = await build('ids');

    // The entry and the dynamically imported chunk.
    expect(files.length).toBeGreaterThanOrEqual(2);
    const ids = files.map((built) => expectDebugId(built));
    expect(new Set(ids).size).toBe(files.length);
  });

  it('registers each file in globalThis._debugIds when the file runs', async () => {
    const { files } = await build('registration');

    for (const built of files) {
      expectRegistration(built, expectDebugId(built), 'module');
    }
  });

  it('leaves the source map mappings correct', async () => {
    const { files } = await build('mappings');

    expectTokenMapsToSource(files, 'lazy-boom-token', 'lazy.js');
    expectTokenMapsToSource(files, 'entry-greeting-token', 'main.js');
    expectTokenMapsToSource(files, 'after-database-token', 'main.js');
  });

  it('gives the same files the same IDs in two identical builds', async () => {
    const first = await build('deterministic-1');
    const second = await build('deterministic-2');

    expect(Object.keys(debugIdsByName(first.files)).length).toBeGreaterThanOrEqual(2);
    expect(debugIdsByName(second.files)).toEqual(debugIdsByName(first.files));
  });

  it("uses the bundler's own debug IDs", async () => {
    const withoutPlugin = await build('native-reference', { plugin: false, output: { sourcemapDebugIds: true } });
    const withPlugin = await build('native');

    // The reference build proves the bundler wrote these IDs itself.
    for (const built of withoutPlugin.files) {
      expect(built.code).toMatch(/\n\/\/# debugId=[0-9a-f-]{36}\n/);
      expect(built.code).not.toContain('_debugIds');
    }
    expect(debugIdsByName(withPlugin.files)).toEqual(debugIdsByName(withoutPlugin.files));
    withPlugin.files.forEach((built) => expectDebugId(built));
  });

  it('derives IDs from content when the bundler writes none', async () => {
    const native = await build('derived-reference');
    const first = await build('derived-1', { output: { sourcemapDebugIds: false } });
    const second = await build('derived-2', { output: { sourcemapDebugIds: false } });

    first.files.forEach((built) => expectDebugId(built));
    for (const built of first.files) {
      expectRegistration(built, expectDebugId(built), 'module');
    }
    expectTokenMapsToSource(first.files, 'lazy-boom-token', 'lazy.js');
    expect(debugIdsByName(second.files)).toEqual(debugIdsByName(first.files));
    expect(Object.values(debugIdsByName(first.files))).not.toEqual(Object.values(debugIdsByName(native.files)));
  });

  it('handles hidden source maps, which have no sourceMappingURL comment', async () => {
    const { files } = await build('hidden', { sourcemap: 'hidden' });

    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const built of files) {
      expect(built.code).not.toContain('sourceMappingURL');
      expectRegistration(built, expectDebugId(built), 'module');
    }
  });

  it('leaves files alone and says so when there are no source map files', async () => {
    const { outDir } = await build('no-maps', { sourcemap: false });

    expect(listSourceMaps(outDir)).toEqual([]);
    expect(lines().filter((line) => line.includes('No source map files were emitted'))).toHaveLength(1);
  });

  describe('inlineDatabase', () => {
    const code = (files: BuiltFile[]) => files.map((built) => built.code).join('\n');

    it('replaces process.env.BUGSPLAT_DATABASE with the database option', async () => {
      const { files } = await build('inline-option', { plugin: { database: 'fred-option' } });

      expect(code(files)).toContain('fred-option');
      expect(code(files)).not.toContain('process.env.BUGSPLAT_DATABASE');
      expectTokenMapsToSource(files, 'after-database-token', 'main.js');
    });

    it('defaults to the BUGSPLAT_DATABASE environment variable', async () => {
      process.env.BUGSPLAT_DATABASE = 'fred-environment';
      const { files } = await build('inline-environment');

      expect(code(files)).toContain('fred-environment');
      expect(code(files)).not.toContain('process.env.BUGSPLAT_DATABASE');
    });

    it('can be turned off', async () => {
      const { files } = await build('inline-off', { plugin: { database: 'fred-option', inlineDatabase: false } });

      // Vite's own handling of `process.env` in browser builds leaves `{}.BUGSPLAT_DATABASE`.
      expect(code(files)).not.toContain('fred-option');
      expect(code(files)).toMatch(/\.BUGSPLAT_DATABASE\b/);
    });
  });

  describe('upload', () => {
    const credentials = { database: 'fred', clientId: 'client-id', clientSecret: 'client-secret' };

    it('uploads the output directory with the configured values and package.json defaults', async () => {
      const { outDir, files } = await build('upload', { plugin: credentials });

      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith({
        database: 'fred',
        application: 'fixture-app',
        version: '1.2.3',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        directory: outDir,
        files: ['**/*.map'],
      });
      // Every map was complete on disk before the upload started, and is still there after it.
      files.forEach((built) => expectDebugId(built));
      expect(lines().filter((line) => line.startsWith('info: Uploaded'))).toHaveLength(1);
    });

    it('reads credentials, database and host from the environment and prefers explicit names', async () => {
      process.env.BUGSPLAT_DATABASE = 'fred-environment';
      process.env.BUGSPLAT_HOST = 'http://localhost:8080';
      process.env.SYMBOL_UPLOAD_CLIENT_ID = 'environment-id';
      process.env.SYMBOL_UPLOAD_CLIENT_SECRET = 'environment-secret';
      const { outDir } = await build('upload-environment', { plugin: { application: 'my-app', version: '9.9.9' } });

      expect(upload).toHaveBeenCalledWith({
        database: 'fred-environment',
        application: 'my-app',
        version: '9.9.9',
        clientId: 'environment-id',
        clientSecret: 'environment-secret',
        host: 'http://localhost:8080',
        directory: outDir,
        files: ['**/*.map'],
      });
    });

    it('skips the upload with one log line when credentials are absent', async () => {
      const { files } = await build('upload-skipped', { plugin: { database: 'fred' } });

      expect(upload).not.toHaveBeenCalled();
      expect(lines()).toEqual([
        'info: Source maps were not uploaded: missing clientId (SYMBOL_UPLOAD_CLIENT_ID), clientSecret (SYMBOL_UPLOAD_CLIENT_SECRET).',
      ]);
      // Debug IDs do not depend on uploading.
      files.forEach((built) => expectDebugId(built));
    });

    it('does not upload when upload is false, and says nothing', async () => {
      await build('upload-off', { plugin: { ...credentials, upload: false } });

      expect(upload).not.toHaveBeenCalled();
      expect(lines()).toEqual([]);
    });

    it('lists the source maps without uploading in a dry run', async () => {
      const { outDir } = await build('upload-dry-run', { plugin: { ...credentials, dryRun: true } });

      expect(upload).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/^info: Dry run: would upload 2 source maps from .*: assets\/.*\.js\.map, assets\/.*\.js\.map$/);
      expect(listSourceMaps(outDir)).toHaveLength(2);
    });

    it('deletes the source maps after a successful upload when asked to', async () => {
      const { outDir } = await build('upload-delete', {
        plugin: { ...credentials, deleteSourceMapsAfterUpload: true },
      });

      expect(upload).toHaveBeenCalledTimes(1);
      expect(listSourceMaps(outDir)).toEqual([]);
    });

    it('keeps the build green and the source maps in place when the upload fails', async () => {
      upload.mockRejectedValue(new Error('401 Unauthorized'));
      const { outDir, files } = await build('upload-failure', {
        plugin: { ...credentials, deleteSourceMapsAfterUpload: true },
      });

      expect(files.length).toBeGreaterThanOrEqual(2);
      expect(listSourceMaps(outDir)).toHaveLength(2);
      expect(lines()).toEqual([
        'error: Source map upload failed: 401 Unauthorized. The build continues; set failOnError: true to fail it.',
      ]);
    });

    it('fails the build when the upload fails and failOnError is set', async () => {
      upload.mockRejectedValue(new Error('401 Unauthorized'));

      await expect(build('upload-fail-on-error', { plugin: { ...credentials, failOnError: true } })).rejects.toThrow(
        /Source map upload failed: 401 Unauthorized/,
      );
    });
  });

  it('repairs on disk a source map that a later plugin rewrote without its debug ID', async () => {
    const stripDebugIds = {
      name: 'strip-debug-ids',
      generateBundle: {
        order: 'post',
        handler(_options: unknown, bundle: Record<string, { type: string; fileName: string; source?: unknown }>) {
          for (const item of Object.values(bundle)) {
            if (item.type === 'asset' && item.fileName.endsWith('.map')) {
              const map = JSON.parse(String(item.source)) as Record<string, unknown>;
              delete map.debugId;
              item.source = JSON.stringify(map);
            }
          }
        },
      },
    };
    const { files } = await build('fallback', { extraPlugins: [stripDebugIds] });

    files.forEach((built) => expectDebugId(built));
    const warnings = lines().filter((line) => line.startsWith('warn: Added debug IDs on disk after the build to: '));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path.basename(files[0]!.file));
  });
});
