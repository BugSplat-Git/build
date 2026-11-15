/**
 * The one place this package touches `@bugsplat/symbol-upload`. Everything else goes through
 * {@link SourceMapUploadRequest} and {@link UploadedSourceMap}, so the plugins and their tests do
 * not depend on that package's API.
 */
import type { UploadSymbolsOptions } from '@bugsplat/symbol-upload';

export interface SourceMapUploadRequest {
  database: string;
  application: string;
  version: string;
  clientId: string;
  clientSecret: string;
  host?: string;
  /** Absolute path of the directory the globs are resolved against. */
  directory: string;
  /** Glob patterns relative to `directory`, written with forward slashes. */
  files: string[];
}

export interface UploadedSourceMap {
  /** Absolute path of the uploaded file. */
  path: string;
  /** The debug ID the file was uploaded by (32 hexadecimal characters), or '' when it has none. */
  debugId: string;
}

/**
 * Uploads the files matched by the globs with `uploadSymbols` from `@bugsplat/symbol-upload`,
 * which authenticates, uploads, cleans up after itself and runs one upload at a time.
 * Rejects when no file matches, when authentication fails or when an upload fails.
 */
export async function uploadWithSymbolUpload(request: SourceMapUploadRequest): Promise<UploadedSourceMap[]> {
  // The package is loaded on first use: a build that does not upload never pays for it.
  // It is CommonJS; depending on how its exports are detected they are named or on `default`.
  const symbolUpload = await import('@bugsplat/symbol-upload');
  const uploadSymbols =
    symbolUpload.uploadSymbols ?? (symbolUpload as unknown as { default?: typeof symbolUpload }).default?.uploadSymbols;
  if (typeof uploadSymbols !== 'function') {
    throw new Error('The installed @bugsplat/symbol-upload has no uploadSymbols function; update @bugsplat/symbol-upload');
  }
  const options: UploadSymbolsOptions = request;
  const uploaded = await uploadSymbols(options);
  return uploaded.map(({ path, dbgId }) => ({ path, debugId: dbgId }));
}
