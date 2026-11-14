import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import webpack, { type Stats } from 'webpack';
import { normaliseDebugId } from '../src/debug-id.js';
import type { BugSplatOptions } from '../src/options.js';
import vitePlugin from '../src/vite.js';
import webpackPlugin from '../src/webpack.js';
import {
  createTestLogger,
  expectDebugId,
  fixtureRoot,
  listSourceMaps,
  outputDirectory,
  readBuiltFiles,
  type BuiltFile,
} from './helpers.js';

// This file uses the real adapter and the real @bugsplat/symbol-upload. The uploads go to the
// throwaway HTTP server below, which stands in for BugSplat.
vi.unmock('../src/symbol-upload.js');

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  fields: Record<string, string>;
  body: Buffer;
}

async function readFormFields(headers: IncomingHttpHeaders, body: Buffer): Promise<Record<string, string>> {
  const response = new Response(new Uint8Array(body), { headers: { 'content-type': headers['content-type'] ?? '' } });
  const fields: Record<string, string> = {};
  (await response.formData()).forEach((value, name) => (fields[name] = String(value)));
  return fields;
}

describe('uploading with the real @bugsplat/symbol-upload', () => {
  let server: Server;
  let host: string;
  let requests: RecordedRequest[] = [];
  let logged = createTestLogger();
  const lines = () => logged.lines.map((line) => `${line.level}: ${line.message}`);

  beforeAll(async () => {
    // Until the @bugsplat/symbol-upload release that exports uploadSymbols is on npm, a plain
    // `npm install` brings in a version without it.
    const symbolUpload = (await import('@bugsplat/symbol-upload')) as { uploadSymbols?: unknown };
    if (typeof symbolUpload.uploadSymbols !== 'function') {
      throw new Error(
        'The installed @bugsplat/symbol-upload has no uploadSymbols. Install the build that has it: ' +
          'npm i --no-save ../artifacts/bugsplat-symbol-upload-11.2.0.tgz',
      );
    }

    // Hands out a token, then a presigned URL on itself for every file.
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);
        const method = request.method ?? '';
        const requestPath = new URL(request.url ?? '/', host).pathname;
        const fields = method === 'POST' ? await readFormFields(request.headers, body) : {};
        requests.push({ method, path: requestPath, headers: request.headers, fields, body });

        const json = (status: number, value: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (method === 'POST' && requestPath === '/oauth2/authorize') {
          return fields.client_id === 'unknown'
            ? json(400, { message: 'Unknown clientId' })
            : json(200, { token_type: 'Bearer', access_token: 'token' });
        }
        if (method === 'POST' && requestPath === '/symsrv/uploadUrl') {
          return json(200, { url: `${host}/presigned/${fields.dbgId}/${fields.symFileName}` });
        }
        if (method === 'POST' && requestPath === '/symsrv/uploadComplete') {
          return json(200, { Status: 'Success' });
        }
        if (method === 'PUT' && requestPath.startsWith('/presigned/')) {
          return json(200, {});
        }
        return json(404, {});
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    host = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // The uploads leave keep-alive sockets open, and close() would wait on them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    logged = createTestLogger();
    // @bugsplat/symbol-upload writes its own progress lines to the console.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const options = (overrides: BugSplatOptions = {}): BugSplatOptions => ({
    database: 'fred',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    host,
    logger: logged.logger,
    ...overrides,
  });

  async function buildWithVite(name: string, pluginOptions: BugSplatOptions): Promise<string> {
    const vite = await import('vite');
    const outDir = outputDirectory(`real-upload-${name}`);
    await vite.build({
      root: fixtureRoot,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      plugins: [vitePlugin(pluginOptions)],
      build: { outDir, emptyOutDir: true, sourcemap: true, minify: true },
    });
    return outDir;
  }

  async function buildWithWebpack(name: string, pluginOptions: BugSplatOptions): Promise<string> {
    const outDir = outputDirectory(`real-upload-${name}`);
    const compiler = webpack({
      context: fixtureRoot,
      mode: 'production',
      entry: './src/main.js',
      devtool: 'source-map',
      output: { path: outDir, filename: '[name].[contenthash:8].js', publicPath: '/' },
      plugins: [webpackPlugin(pluginOptions)],
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, result) => {
        compiler.close(() => (error || !result ? reject(error ?? new Error('no stats')) : resolve(result)));
      });
    });
    expect(stats.hasErrors()).toBe(false);
    return outDir;
  }

  const requestsTo = (method: string, prefix: string) =>
    requests.filter((request) => request.method === method && request.path.startsWith(prefix));

  /** Asserts that every source map of the build was uploaded, whole, under its own debug ID. */
  function expectUploaded(files: BuiltFile[]): void {
    expect(requestsTo('POST', '/oauth2/authorize')).toHaveLength(1);
    expect(requestsTo('POST', '/oauth2/authorize')[0]!.fields).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });

    expect(files).toHaveLength(3);
    expect(requestsTo('POST', '/symsrv/uploadUrl')).toHaveLength(files.length);
    expect(requestsTo('PUT', '/presigned/')).toHaveLength(files.length);
    expect(requestsTo('POST', '/symsrv/uploadComplete')).toHaveLength(files.length);

    for (const built of files) {
      const mapName = path.basename(built.mapFile);
      const dbgId = normaliseDebugId(expectDebugId(built))!;
      const expectedFields = {
        database: 'fred',
        appName: 'fixture-app',
        appVersion: '1.2.3',
        dbgId,
        symFileName: mapName,
        moduleName: mapName,
      };

      const uploadUrl = requestsTo('POST', '/symsrv/uploadUrl').filter((request) => request.fields.dbgId === dbgId);
      expect(uploadUrl, `${mapName}: one upload URL request`).toHaveLength(1);
      expect(uploadUrl[0]!.fields).toMatchObject(expectedFields);
      expect(uploadUrl[0]!.headers.authorization).toBe('Bearer token');

      const put = requestsTo('PUT', `/presigned/${dbgId}/`);
      expect(put, `${mapName}: one upload`).toHaveLength(1);
      expect(put[0]!.headers['content-encoding']).toBe('gzip');
      // The bytes that were uploaded are the bytes on disk, debug ID included.
      expect(gunzipSync(put[0]!.body).toString()).toBe(readFileSync(built.mapFile, 'utf8'));

      const complete = requestsTo('POST', '/symsrv/uploadComplete').filter((request) => request.fields.dbgId === dbgId);
      expect(complete, `${mapName}: one completion request`).toHaveLength(1);
      expect(complete[0]!.fields).toMatchObject(expectedFields);
    }
  }

  it('uploads every source map of a Vite build under its debug ID', async () => {
    const outDir = await buildWithVite('vite', options());

    expectUploaded(readBuiltFiles(outDir));
    expect(lines()).toEqual([
      expect.stringMatching(/^info: Uploading 3 source maps from .* to database fred \(fixture-app 1\.2\.3\)\.\.\.$/),
      expect.stringMatching(/^info: Uploaded 3 source maps from .* to database fred \(fixture-app 1\.2\.3\)\.$/),
    ]);
  });

  it('uploads every source map of a webpack build under its debug ID', async () => {
    const outDir = await buildWithWebpack('webpack', options());

    expectUploaded(readBuiltFiles(outDir));
    expect(lines().filter((line) => !line.startsWith('info: '))).toEqual([]);
  });

  it('deletes the source maps it uploaded', async () => {
    const outDir = await buildWithVite('delete', options({ deleteSourceMapsAfterUpload: true }));

    expect(requestsTo('PUT', '/presigned/')).toHaveLength(3);
    expect(listSourceMaps(outDir)).toEqual([]);
  });

  it('keeps the build green, and the source maps, when BugSplat rejects the credentials', async () => {
    const outDir = await buildWithVite(
      'rejected',
      options({ clientId: 'unknown', deleteSourceMapsAfterUpload: true }),
    );

    expect(requestsTo('PUT', '/presigned/')).toEqual([]);
    expect(listSourceMaps(outDir)).toHaveLength(3);
    expect(lines().filter((line) => line.startsWith('error: '))).toEqual([
      expect.stringMatching(
        /^error: Source map upload failed: .*Unknown clientId.*\. The build continues; set failOnError: true to fail it\.$/s,
      ),
    ]);
  });
});
