import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { afterWrite } from '../src/after-write.js';
import { deriveDebugId } from '../src/debug-id.js';
import { uploadWithSymbolUpload } from '../src/symbol-upload.js';
import { uploadSourceMaps } from '../src/upload.js';
import { createTestLogger, fakeUpload, fixtureRoot, listSourceMaps, outputDirectory } from './helpers.js';

const upload = vi.mocked(uploadWithSymbolUpload);
const settings = {
  database: 'fred',
  application: 'my-app',
  version: '1.0.0',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

function directoryWithMaps(name: string, maps = ['a.js.map', 'nested/b.js.map']): string {
  const directory = outputDirectory(name);
  for (const map of maps) {
    mkdirSync(path.dirname(path.join(directory, map)), { recursive: true });
    writeFileSync(path.join(directory, map), JSON.stringify({ version: 3, debugId: deriveDebugId(map) }));
  }
  return directory;
}

beforeEach(() => {
  upload.mockReset();
  upload.mockImplementation(fakeUpload);
});

describe('uploadSourceMaps', () => {
  it('uploads every .map file below the directory', async () => {
    const directory = directoryWithMaps('upload-core');
    const { logger, lines } = createTestLogger();

    const result = await uploadSourceMaps({ ...settings, host: 'http://localhost:8080', directory, logger });

    expect(upload).toHaveBeenCalledWith({
      ...settings,
      host: 'http://localhost:8080',
      directory,
      files: ['**/*.map'],
    });
    expect(result).toEqual({
      sourceMaps: [path.join(directory, 'a.js.map'), path.join(directory, 'nested', 'b.js.map')],
      uploaded: true,
      deleted: [],
    });
    expect(lines.map((line) => line.level)).toEqual(['info', 'info']);
    expect(lines[0]!.message).toMatch(/^Uploading 2 source maps from .* to database fred \(my-app 1\.0\.0\)\.\.\.$/);
    expect(lines[1]!.message).toMatch(/^Uploaded 2 source maps from .* to database fred \(my-app 1\.0\.0\)\.$/);
  });

  it('warns about uploaded JavaScript source maps that have no debug ID, and not about other source maps', async () => {
    const directory = directoryWithMaps('upload-core-no-id');
    writeFileSync(path.join(directory, 'legacy.js.map'), '{"version":3}');
    writeFileSync(path.join(directory, 'style.css.map'), '{"version":3}');
    const { logger, lines } = createTestLogger();

    await uploadSourceMaps({ ...settings, directory, logger });

    expect(lines.filter((line) => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'These source maps have no debug ID, so BugSplat can only match them by file name: legacy.js.map',
      },
    ]);
  });

  it('takes application and version from the package.json at or above root', async () => {
    const directory = directoryWithMaps('upload-core-defaults');
    const { logger } = createTestLogger();

    await uploadSourceMaps({
      database: 'fred',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      directory,
      root: path.join(fixtureRoot, 'src'),
      logger,
    });

    expect(upload.mock.calls[0]![0]).toMatchObject({ application: 'fixture-app', version: '1.2.3' });
  });

  it('rejects, naming every missing setting, before uploading anything', async () => {
    const directory = directoryWithMaps('upload-core-missing');
    const { logger } = createTestLogger();

    await expect(uploadSourceMaps({ application: 'my-app', version: '1.0.0', directory, logger })).rejects.toThrow(
      'missing database (BUGSPLAT_DATABASE), clientId (SYMBOL_UPLOAD_CLIENT_ID), clientSecret (SYMBOL_UPLOAD_CLIENT_SECRET)',
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('warns instead of uploading when the directory has no source maps', async () => {
    const directory = directoryWithMaps('upload-core-empty', []);
    const { logger, lines } = createTestLogger();

    const result = await uploadSourceMaps({ ...settings, directory, logger });

    expect(result).toEqual({ sourceMaps: [], uploaded: false, deleted: [] });
    expect(upload).not.toHaveBeenCalled();
    expect(lines.map((line) => line.level)).toEqual(['warn']);
  });

  it('deletes the source maps only after the upload succeeded', async () => {
    const failing = directoryWithMaps('upload-core-delete-failure');
    const succeeding = directoryWithMaps('upload-core-delete');
    const { logger } = createTestLogger();
    upload.mockRejectedValueOnce(new Error('boom'));

    await expect(
      uploadSourceMaps({ ...settings, directory: failing, deleteSourceMapsAfterUpload: true, logger }),
    ).rejects.toThrow('boom');
    expect(listSourceMaps(failing)).toHaveLength(2);

    const result = await uploadSourceMaps({ ...settings, directory: succeeding, deleteSourceMapsAfterUpload: true, logger });
    expect(result.deleted).toEqual(result.sourceMaps);
    expect(listSourceMaps(succeeding)).toEqual([]);
  });

  it('neither uploads nor deletes in a dry run, and needs no credentials', async () => {
    const directory = directoryWithMaps('upload-core-dry-run');
    const { logger, lines } = createTestLogger();

    const result = await uploadSourceMaps({ directory, dryRun: true, deleteSourceMapsAfterUpload: true, logger });

    expect(result).toMatchObject({ uploaded: false, deleted: [] });
    expect(upload).not.toHaveBeenCalled();
    expect(listSourceMaps(directory)).toHaveLength(2);
    expect(lines[0]!.message).toContain(`a.js.map, ${path.join('nested', 'b.js.map')}`);
  });
});

describe('afterWrite', () => {
  const context = (directory: string, options: object, watchMode = false) => {
    const logged = createTestLogger();
    return {
      logged,
      context: {
        options: { logger: logged.logger, ...options },
        root: fixtureRoot,
        directory,
        files: [] as string[],
        watchMode,
      },
    };
  };

  it('does not upload in watch mode unless upload is true', async () => {
    const directory = directoryWithMaps('after-write-watch');
    const implicit = context(directory, settings, true);
    const explicit = context(directory, { ...settings, upload: true }, true);

    expect(await afterWrite(implicit.context)).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(implicit.logged.lines).toEqual([
      { level: 'info', message: 'Source maps are not uploaded in watch mode. Set upload: true to upload them anyway.' },
    ]);

    expect(await afterWrite(explicit.context)).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("deletes only its own build's source maps from an output directory that two builds share", async () => {
    // Electron Forge writes the main and the preload build to the same folder.
    const directory = directoryWithMaps('after-write-shared', ['main.js.map', 'preload.js.map']);
    const main = context(directory, { ...settings, deleteSourceMapsAfterUpload: true });
    main.context.files = ['main.js', 'main.js.map'];
    const preload = context(directory, { ...settings, deleteSourceMapsAfterUpload: true });
    preload.context.files = ['preload.js', 'preload.js.map'];

    expect(await afterWrite(main.context)).toBeUndefined();
    expect(listSourceMaps(directory)).toEqual([path.join(directory, 'preload.js.map')]);

    expect(await afterWrite(preload.context)).toBeUndefined();
    expect(listSourceMaps(directory)).toEqual([]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(preload.logged.lines.map((line) => line.message)).toEqual([
      expect.stringMatching(/^Uploading 1 source map from /),
      expect.stringMatching(/^Uploaded 1 source map from /),
      expect.stringMatching(/^Deleted 1 source map from /),
    ]);
  });

  it('treats upload: true without credentials as a failed upload', async () => {
    const directory = directoryWithMaps('after-write-explicit');
    const lenient = context(directory, { database: 'fred', upload: true });
    const strict = context(directory, { database: 'fred', upload: true, failOnError: true });

    expect(await afterWrite(lenient.context)).toBeUndefined();
    expect(lenient.logged.lines.map((line) => line.level)).toEqual(['error']);
    expect(lenient.logged.lines[0]!.message).toContain('missing clientId (SYMBOL_UPLOAD_CLIENT_ID)');

    const error = await afterWrite(strict.context);
    expect(error?.message).toContain('Source map upload failed: missing clientId (SYMBOL_UPLOAD_CLIENT_ID)');
    expect(upload).not.toHaveBeenCalled();
  });
});
