/**
 * The one place this package touches `@bugsplat/symbol-upload`. Everything else goes through
 * {@link SourceMapUploadRequest}, so the plugins and their tests do not depend on that package's API.
 *
 * UPLOAD ADAPTER: PENDING. `@bugsplat/symbol-upload` does not yet publish the high-level function
 * this needs. The call below is written against the shape agreed in the shared contract and is
 * wired to the real package once its tarball is available.
 */

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

export async function uploadWithSymbolUpload(request: SourceMapUploadRequest): Promise<void> {
  // The package is loaded on first use: a build that does not upload never pays for it.
  const specifier = '@bugsplat/symbol-upload';
  const symbolUpload = (await import(specifier)) as {
    uploadSymbols?: (options: SourceMapUploadRequest) => Promise<unknown>;
    default?: { uploadSymbols?: (options: SourceMapUploadRequest) => Promise<unknown> };
  };
  const uploadSymbols = symbolUpload.uploadSymbols ?? symbolUpload.default?.uploadSymbols;
  if (typeof uploadSymbols !== 'function') {
    throw new Error('The installed @bugsplat/symbol-upload does not export uploadSymbols; update it');
  }
  await uploadSymbols(request);
}
