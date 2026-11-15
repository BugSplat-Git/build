import type { Plugin } from 'rollup';
import type { BugSplatOptions } from './options.js';
import { createRollupPlugin } from './rollup-plugin.js';

export type { BugSplatOptions, Logger } from './options.js';

/**
 * Rollup plugin: gives every emitted JavaScript file and its source map a debug ID, appends the
 * snippet that registers the ID at runtime, and uploads the source maps to BugSplat.
 */
export function bugsplat(options: BugSplatOptions = {}): Plugin {
  return createRollupPlugin(options, { databaseIsDefined: false });
}

export default bugsplat;
