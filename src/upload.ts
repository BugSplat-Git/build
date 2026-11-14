import { rm } from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from './fs.js';
import { resolveOptions, type BugSplatOptions } from './options.js';
import { uploadWithSymbolUpload } from './symbol-upload.js';

/** The glob that selects the files to upload, relative to the output directory. */
export const SOURCE_MAP_GLOB = '**/*.map';

export interface UploadSourceMapsOptions
  extends Pick<
    BugSplatOptions,
    | 'database'
    | 'application'
    | 'version'
    | 'clientId'
    | 'clientSecret'
    | 'host'
    | 'deleteSourceMapsAfterUpload'
    | 'dryRun'
    | 'logger'
  > {
  /** The build's output directory. Every `.map` file below it is uploaded. */
  directory: string;
  /** The project directory, where package.json supplies the default `application` and `version`. Default: the current directory. */
  root?: string;
}

export interface UploadSourceMapsResult {
  /** Absolute paths of the source maps found below the directory. */
  sourceMaps: string[];
  /** True when the source maps were uploaded; false for a dry run or when there were none. */
  uploaded: boolean;
  /** True when the source maps were deleted after the upload. */
  deleted: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Names the settings an upload needs that have no value, each with the environment variable that
 * can supply it.
 */
export function missingUploadSettings(options: {
  database?: string;
  application?: string;
  version?: string;
  clientId?: string;
  clientSecret?: string;
}): string[] {
  const missing = [];
  if (!options.database) missing.push('database (BUGSPLAT_DATABASE)');
  if (!options.application) missing.push('application (name in package.json)');
  if (!options.version) missing.push('version (version in package.json)');
  if (!options.clientId) missing.push('clientId (SYMBOL_UPLOAD_CLIENT_ID)');
  if (!options.clientSecret) missing.push('clientSecret (SYMBOL_UPLOAD_CLIENT_SECRET)');
  return missing;
}

/**
 * Uploads every `.map` file below a directory to BugSplat.
 *
 * Rejects when a required setting is missing or the upload fails. Finding no source maps is not
 * an error: one warning is logged and `uploaded` is false.
 */
export async function uploadSourceMaps(options: UploadSourceMapsOptions): Promise<UploadSourceMapsResult> {
  const directory = path.resolve(options.directory);
  const resolved = resolveOptions(options, options.root);
  const { logger } = resolved;
  const where = path.relative(process.cwd(), directory) || '.';

  const sourceMaps = await listFiles(directory, (name) => name.endsWith('.map'));
  if (!sourceMaps.length) {
    logger.warn(`No source maps found in ${where}, so nothing was uploaded. Turn on source maps in your bundler.`);
    return { sourceMaps, uploaded: false, deleted: false };
  }

  if (resolved.dryRun) {
    const names = sourceMaps.map((file) => path.relative(directory, file)).join(', ');
    logger.info(`Dry run: would upload ${plural(sourceMaps.length, 'source map')} from ${where}: ${names}`);
    return { sourceMaps, uploaded: false, deleted: false };
  }

  const missing = missingUploadSettings(resolved);
  if (missing.length) {
    throw new Error(`missing ${missing.join(', ')}`);
  }

  await uploadWithSymbolUpload({
    database: resolved.database!,
    application: resolved.application!,
    version: resolved.version!,
    clientId: resolved.clientId!,
    clientSecret: resolved.clientSecret!,
    ...(resolved.host ? { host: resolved.host } : {}),
    directory,
    files: [SOURCE_MAP_GLOB],
  });
  logger.info(
    `Uploaded ${plural(sourceMaps.length, 'source map')} from ${where} to database ${resolved.database} (${resolved.application} ${resolved.version}).`,
  );

  if (resolved.deleteSourceMapsAfterUpload) {
    await Promise.all(sourceMaps.map((file) => rm(file, { force: true })));
    logger.info(`Deleted ${plural(sourceMaps.length, 'source map')} from ${where}.`);
  }
  return { sourceMaps, uploaded: true, deleted: resolved.deleteSourceMapsAfterUpload };
}
