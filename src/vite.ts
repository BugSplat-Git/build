import type { Plugin } from 'vite';
import { DATABASE_EXPRESSION, databaseToInline, type BugSplatOptions } from './options.js';
import { createRollupPlugin, type PluginState } from './rollup-plugin.js';

export type { BugSplatOptions, Logger } from './options.js';

/**
 * Vite plugin: gives every emitted JavaScript file and its source map a debug ID, appends the
 * snippet that registers the ID at runtime, and uploads the source maps to BugSplat.
 *
 * It is the Rollup plugin plus Vite's `define` for `process.env.BUGSPLAT_DATABASE`, and it also
 * works in a plain Rollup config.
 */
export function bugsplat(options: BugSplatOptions = {}): Plugin {
  const state: PluginState = { databaseIsDefined: false };
  const vitePlugin: Pick<Plugin, 'config' | 'configResolved'> = {
    config(userConfig) {
      // From here on Vite replaces the expression (in the dev server too), so the Rollup
      // transform hook stands down. A value the user defined themselves is left alone.
      state.databaseIsDefined = true;
      const database = databaseToInline(options);
      if (!database || (userConfig.define && DATABASE_EXPRESSION in userConfig.define)) {
        return undefined;
      }
      return { define: { [DATABASE_EXPRESSION]: JSON.stringify(database) } };
    },
    configResolved(config) {
      state.root = config.root;
    },
  };
  return { ...(createRollupPlugin(options, state) as unknown as Plugin), ...vitePlugin };
}

export default bugsplat;
