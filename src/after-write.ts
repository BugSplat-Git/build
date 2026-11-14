import path from 'node:path';
import { injectDebugIdIntoFile } from './fs.js';
import { resolveOptions, type BugSplatOptions } from './options.js';
import { missingUploadSettings, uploadSourceMaps } from './upload.js';

const JAVASCRIPT_FILE = /\.[cm]?js$/;

export interface AfterWriteContext {
  options: BugSplatOptions;
  /** The project directory, for the package.json defaults. */
  root: string;
  /** Absolute path of the directory the bundler wrote to. */
  directory: string;
  /** The files this build emitted, relative to `directory`. */
  files: string[];
  /** True when the bundler rebuilds on change. */
  watchMode: boolean;
}

/**
 * What every bundler plugin does once the bundle is on disk: check the emitted files, then upload.
 *
 * Resolves with an error only when the upload failed and `failOnError` is set; the caller fails
 * the build with it. Every other outcome is one log line.
 */
export async function afterWrite(context: AfterWriteContext): Promise<Error | undefined> {
  const { directory } = context;
  const options = resolveOptions(context.options, context.root);
  const { logger } = options;

  // Fallback. The plugins give files their debug IDs inside the bundler, but a plugin that runs
  // later can emit a file, or rewrite a source map, after that. Any emitted JavaScript file that
  // reached the disk without an ID gets one here. Files that are already complete are not written.
  const repaired = [];
  for (const file of context.files) {
    if (!JAVASCRIPT_FILE.test(file)) {
      continue;
    }
    try {
      const result = await injectDebugIdIntoFile(path.resolve(directory, file));
      if (result.changed) {
        repaired.push(file);
      }
    } catch {
      // The file was not written (an in-memory dev server, for example) or cannot be read.
    }
  }
  if (repaired.length) {
    logger.warn(
      `Added debug IDs on disk after the build to: ${repaired.join(', ')}. ` +
        'Hashes or compressed copies of these files made by other plugins may be out of date.',
    );
  }

  if (options.upload === false) {
    return undefined;
  }
  if (options.upload === undefined && !options.dryRun) {
    if (context.watchMode) {
      logger.info('Source maps are not uploaded in watch mode. Set upload: true to upload them anyway.');
      return undefined;
    }
    const missing = missingUploadSettings(options);
    if (missing.length) {
      logger.info(`Source maps were not uploaded: missing ${missing.join(', ')}.`);
      return undefined;
    }
  }

  try {
    await uploadSourceMaps({ ...context.options, directory, root: context.root });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.failOnError) {
      logger.error(`Source map upload failed: ${message}`);
      return new Error(`[bugsplat] Source map upload failed: ${message}`, { cause: error });
    }
    logger.error(`Source map upload failed: ${message}. The build continues; set failOnError: true to fail it.`);
    return undefined;
  }
}
