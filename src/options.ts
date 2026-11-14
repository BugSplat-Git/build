import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BugSplatOptions {
  /** BugSplat database name. Default: the `BUGSPLAT_DATABASE` environment variable. */
  database?: string;
  /** Application name, as the app passes it to the BugSplat SDK. Default: `name` in the project's package.json. */
  application?: string;
  /** Application version, as the app passes it to the BugSplat SDK. Default: `version` in the project's package.json. */
  version?: string;
  /** OAuth2 Client Credentials client ID. Default: the `SYMBOL_UPLOAD_CLIENT_ID` environment variable. */
  clientId?: string;
  /** OAuth2 Client Credentials client secret. Default: the `SYMBOL_UPLOAD_CLIENT_SECRET` environment variable. */
  clientSecret?: string;
  /** Base URL of the BugSplat API. Default: the `BUGSPLAT_HOST` environment variable, then BugSplat's own default. */
  host?: string;
  /**
   * Upload the source maps after the bundle is written. Default: true when `database`, `clientId`
   * and `clientSecret` are all available and the bundler is not in watch mode; otherwise the
   * upload is skipped and one line says why.
   */
  upload?: boolean;
  /** Delete the `.map` files from the output directory after a successful upload. Default: false. */
  deleteSourceMapsAfterUpload?: boolean;
  /** Log what would be uploaded without uploading or deleting anything. Default: false. */
  dryRun?: boolean;
  /**
   * Replace `process.env.BUGSPLAT_DATABASE` in your source with the database name at build time,
   * so `init({ database: process.env.BUGSPLAT_DATABASE })` works on your users' machines.
   * Default: true.
   */
  inlineDatabase?: boolean;
  /** Fail the build when the upload fails. Default: false (one line is logged and the build succeeds). */
  failOnError?: boolean;
  /** Where the plugin's log lines go. Default: the console, each line prefixed with `[bugsplat]`. */
  logger?: Logger;
}

export interface ResolvedOptions {
  database?: string;
  application?: string;
  version?: string;
  clientId?: string;
  clientSecret?: string;
  host?: string;
  upload?: boolean;
  deleteSourceMapsAfterUpload: boolean;
  dryRun: boolean;
  inlineDatabase: boolean;
  failOnError: boolean;
  logger: Logger;
}

/** The expression that `inlineDatabase` replaces. */
export const DATABASE_EXPRESSION = 'process.env.BUGSPLAT_DATABASE';

export const consoleLogger: Logger = {
  info: (message) => console.log(`[bugsplat] ${message}`),
  warn: (message) => console.warn(`[bugsplat] ${message}`),
  error: (message) => console.error(`[bugsplat] ${message}`),
};

/** Reads `name` and `version` from the nearest package.json at or above a directory. */
export function readPackageJson(root: string): { name?: string; version?: string } {
  let directory = path.resolve(root);
  for (;;) {
    try {
      const json: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const { name, version } = (json ?? {}) as Record<string, unknown>;
      return {
        name: typeof name === 'string' && name ? name : undefined,
        version: typeof version === 'string' && version ? version : undefined,
      };
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        return {};
      }
      directory = parent;
    }
  }
}

/**
 * The database name that `inlineDatabase` puts in place of `process.env.BUGSPLAT_DATABASE`, or
 * undefined when the option is off or no database is configured.
 */
export function databaseToInline(options: BugSplatOptions = {}): string | undefined {
  if (options.inlineDatabase === false) {
    return undefined;
  }
  return options.database || process.env.BUGSPLAT_DATABASE || undefined;
}

/**
 * Fills in the defaults. Environment variables are read when this is called (inside a bundler
 * hook), not when the plugin is created, so a config file can set them after calling the plugin.
 *
 * @param root The project directory, where the search for package.json starts.
 */
export function resolveOptions(options: BugSplatOptions = {}, root: string = process.cwd()): ResolvedOptions {
  const env = process.env;
  const needsPackageJson = !options.application || !options.version;
  const packageJson = needsPackageJson ? readPackageJson(root) : {};
  return {
    database: options.database || env.BUGSPLAT_DATABASE || undefined,
    application: options.application || packageJson.name,
    version: options.version || packageJson.version,
    clientId: options.clientId || env.SYMBOL_UPLOAD_CLIENT_ID || undefined,
    clientSecret: options.clientSecret || env.SYMBOL_UPLOAD_CLIENT_SECRET || undefined,
    host: options.host || env.BUGSPLAT_HOST || undefined,
    upload: options.upload,
    deleteSourceMapsAfterUpload: options.deleteSourceMapsAfterUpload ?? false,
    dryRun: options.dryRun ?? false,
    inlineDatabase: options.inlineDatabase ?? true,
    failOnError: options.failOnError ?? false,
    logger: options.logger ?? consoleLogger,
  };
}
