import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import webpack, { type Compiler, type Configuration, type Stats, type WebpackPluginInstance } from 'webpack';
import type { BugSplatOptions } from '../src/options.js';
import { uploadWithSymbolUpload } from '../src/symbol-upload.js';
import bugsplat, { BugSplatWebpackPlugin } from '../src/webpack.js';
import {
  createTestLogger,
  debugIdsByName,
  expectDebugId,
  expectRegistration,
  expectTokenMapsToSource,
  fakeUpload,
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
  devtool?: Configuration['devtool'];
  extraPlugins?: WebpackPluginInstance[];
  /** Default: names with a content hash. */
  filename?: string;
  /** Build into the directory of an earlier build, as it is, instead of an empty one. */
  outDir?: string;
}

describe(`webpack ${webpack.version}`, () => {
  const lines = () => logged.lines.map((line) => `${line.level}: ${line.message}`);
  let logged = createTestLogger();

  beforeEach(() => {
    logged = createTestLogger();
    upload.mockReset();
    upload.mockImplementation(fakeUpload);
  });

  async function build(
    name: string,
    settings: BuildSettings = {},
  ): Promise<{ outDir: string; files: BuiltFile[]; stats: Stats }> {
    const outDir = settings.outDir ?? outputDirectory(`webpack-${name}`);
    const plugins: WebpackPluginInstance[] = [];
    if (settings.plugin !== false) {
      plugins.push(bugsplat({ logger: logged.logger, ...settings.plugin }));
    }
    plugins.push(...(settings.extraPlugins ?? []));
    const compiler = webpack({
      context: fixtureRoot,
      // Production mode minifies with terser and splits the dynamic import into its own chunk.
      mode: 'production',
      entry: './src/main.js',
      devtool: settings.devtool ?? 'source-map',
      output: {
        path: outDir,
        // Content hashes exercise webpack's realContentHash pass, which renames files late.
        filename: settings.filename ?? '[name].[contenthash:8].js',
        chunkFilename: settings.filename ?? '[name].[contenthash:8].js',
        publicPath: '/',
      },
      plugins,
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, result) => {
        compiler.close((closeError) => {
          if (error || closeError || !result) {
            reject(error ?? closeError ?? new Error('webpack returned no stats'));
          } else {
            resolve(result);
          }
        });
      });
    });
    return { outDir, files: readBuiltFiles(outDir), stats };
  }

  function expectNoProblems(stats: Stats): void {
    const { errors, warnings } = stats.toJson({ all: false, errors: true, warnings: true });
    expect(errors?.map((error) => error.message)).toEqual([]);
    expect(warnings?.map((warning) => warning.message)).toEqual([]);
  }

  it('writes one debug ID to every JavaScript file and its source map', async () => {
    const { files, stats } = await build('ids');

    expectNoProblems(stats);
    // The entry, the dynamically imported chunk and the worker.
    expect(files).toHaveLength(3);
    const ids = files.map((built) => expectDebugId(built));
    expect(new Set(ids).size).toBe(files.length);
  });

  it('registers each file in globalThis._debugIds when the file runs', async () => {
    const { files } = await build('registration');

    for (const built of files) {
      expectRegistration(built, expectDebugId(built), 'script');
    }
  });

  it('leaves the source map mappings correct', async () => {
    const { files } = await build('mappings');

    expectTokenMapsToSource(files, 'lazy-boom-token', 'lazy.js');
    expectTokenMapsToSource(files, 'entry-greeting-token', 'main.js');
    expectTokenMapsToSource(files, 'after-database-token', 'main.js');
    expectTokenMapsToSource(files, 'worker-reply-token', 'worker.js');
  });

  it('derives the same IDs in two identical builds', async () => {
    const first = await build('deterministic-1');
    const second = await build('deterministic-2');

    expect(Object.keys(debugIdsByName(first.files))).toHaveLength(3);
    expect(debugIdsByName(second.files)).toEqual(debugIdsByName(first.files));
  });

  it("uses webpack's own debug IDs with devtool source-map-debugids", async () => {
    const withoutPlugin = await build('native-reference', { plugin: false, devtool: 'source-map-debugids' });
    const withPlugin = await build('native', { devtool: 'source-map-debugids' });
    const derived = await build('native-derived', { devtool: 'source-map' });

    // The reference build proves webpack wrote these IDs itself.
    for (const built of withoutPlugin.files) {
      expect(built.code).toMatch(/\n\/\/# debugId=[0-9a-f-]{36}\n/);
      expect(built.code).not.toContain('_debugIds');
    }
    const nativeIds = Object.values(debugIdsByName(withoutPlugin.files)).sort();
    expect(Object.values(debugIdsByName(withPlugin.files)).sort()).toEqual(nativeIds);
    expect(Object.values(debugIdsByName(derived.files)).sort()).not.toEqual(nativeIds);
    for (const built of withPlugin.files) {
      expectRegistration(built, expectDebugId(built), 'script');
    }
  });

  it('handles hidden source maps, which have no sourceMappingURL comment', async () => {
    const { files } = await build('hidden', { devtool: 'hidden-source-map' });

    expect(files).toHaveLength(3);
    for (const built of files) {
      expect(built.code).not.toContain('sourceMappingURL');
      expectRegistration(built, expectDebugId(built), 'script');
    }
  });

  it('does not change devtool, and says so once when there are no source map files', async () => {
    const { outDir, stats } = await build('no-maps', { devtool: false });

    expect(stats.compilation.options.devtool).toBe(false);
    expect(listSourceMaps(outDir)).toEqual([]);
    expect(lines().filter((line) => line.includes('No source map files were emitted'))).toHaveLength(1);
  });

  it('finishes inside the compilation: later stages see the bytes that reach the disk', async () => {
    const seen = new Map<string, string>();
    const recordAtReportStage: WebpackPluginInstance = {
      apply(compiler: Compiler) {
        compiler.hooks.thisCompilation.tap('record', (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: 'record', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT },
            (assets) => {
              for (const [name, source] of Object.entries(assets)) {
                seen.set(name, source.source().toString());
              }
            },
          );
        });
      },
    };
    const { outDir, files } = await build('in-pipeline', { extraPlugins: [recordAtReportStage] });

    expect(seen.size).toBe(files.length * 2);
    for (const [name, content] of seen) {
      expect(readFileSync(path.join(outDir, name), 'utf8')).toBe(content);
    }
    expect(lines().filter((line) => line.includes('Added debug IDs on disk'))).toEqual([]);
  });

  it('does not give a rebuilt file the debug ID of a source map that an earlier build left behind', async () => {
    // webpack does not empty the output directory unless output.clean is set.
    const first = await build('stale-map', { filename: '[name].js' });
    const second = await build('stale-map', {
      outDir: first.outDir,
      filename: '[name].js',
      devtool: false,
      plugin: { database: 'changed-code' },
    });

    // The source maps of the first build are still next to the rebuilt files.
    expect(second.files.map((built) => built.name)).toEqual(first.files.map((built) => built.name));
    expect(second.files.map((built) => built.code).join('\n')).toContain('changed-code');
    for (const built of second.files) {
      expect(built.code, built.name).not.toContain('debugId');
      expect(built.code, built.name).not.toContain('_debugIds');
    }
    expect(lines().filter((line) => line.includes('Added debug IDs on disk'))).toEqual([]);
  });

  describe('inlineDatabase', () => {
    const code = (files: BuiltFile[]) => files.map((built) => built.code).join('\n');

    it('replaces process.env.BUGSPLAT_DATABASE with the database option', async () => {
      const { files, stats } = await build('inline-option', { plugin: { database: 'fred-option' } });

      expectNoProblems(stats);
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

      expect(code(files)).not.toContain('fred-option');
      expect(code(files)).toContain('process.env.BUGSPLAT_DATABASE');
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
      files.forEach((built) => expectDebugId(built));
      expect(lines()).toEqual([
        expect.stringMatching(/^info: Uploading 3 source maps from .* to database fred \(fixture-app 1\.2\.3\)\.\.\.$/),
        expect.stringMatching(/^info: Uploaded 3 source maps from .* to database fred \(fixture-app 1\.2\.3\)\.$/),
      ]);
    });

    it('skips the upload with one log line when credentials are absent', async () => {
      const { files } = await build('upload-skipped', { plugin: { database: 'fred' } });

      expect(upload).not.toHaveBeenCalled();
      expect(lines()).toEqual([
        'info: Source maps were not uploaded: missing clientId (SYMBOL_UPLOAD_CLIENT_ID), clientSecret (SYMBOL_UPLOAD_CLIENT_SECRET).',
      ]);
      files.forEach((built) => expectDebugId(built));
    });

    it('deletes the source maps after a successful upload when asked to', async () => {
      const { outDir } = await build('upload-delete', {
        plugin: { ...credentials, deleteSourceMapsAfterUpload: true },
      });

      expect(upload).toHaveBeenCalledTimes(1);
      expect(listSourceMaps(outDir)).toEqual([]);
    });

    it('lists the source maps without uploading in a dry run', async () => {
      const { outDir } = await build('upload-dry-run', { plugin: { ...credentials, dryRun: true } });

      expect(upload).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/^info: Dry run: would upload 3 source maps from /);
      expect(listSourceMaps(outDir)).toHaveLength(3);
    });

    it('keeps the build green when the upload fails', async () => {
      upload.mockRejectedValue(new Error('401 Unauthorized'));
      const { stats } = await build('upload-failure', { plugin: credentials });

      expectNoProblems(stats);
      expect(lines()).toEqual([
        expect.stringMatching(/^info: Uploading 3 source maps from .* to database fred \(fixture-app 1\.2\.3\)\.\.\.$/),
        'error: Source map upload failed: 401 Unauthorized. The build continues; set failOnError: true to fail it.',
      ]);
    });

    it('fails the build when the upload fails and failOnError is set', async () => {
      upload.mockRejectedValue(new Error('401 Unauthorized'));
      const { stats } = await build('upload-fail-on-error', { plugin: { ...credentials, failOnError: true } });

      expect(stats.hasErrors()).toBe(true);
      expect(stats.toJson({ all: false, errors: true }).errors?.map((error) => error.message)).toEqual([
        '[bugsplat] Source map upload failed: 401 Unauthorized',
      ]);
    });
  });

  it('exports the plugin as a class as well', () => {
    expect(bugsplat()).toBeInstanceOf(BugSplatWebpackPlugin);
  });
});
