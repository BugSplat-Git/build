import type { Compilation, Compiler, WebpackPluginInstance } from 'webpack';
import { afterWrite } from './after-write.js';
import { injectDebugId } from './inject.js';
import { consoleLogger, DATABASE_EXPRESSION, databaseToInline, type BugSplatOptions } from './options.js';

export type { BugSplatOptions, Logger } from './options.js';

const PLUGIN_NAME = 'BugSplatWebpackPlugin';
const JAVASCRIPT_FILE = /\.[cm]?js$/;

function withoutQuery(assetName: string): string {
  return assetName.replace(/\?.*$/, '');
}

/**
 * webpack 5 plugin: gives every emitted JavaScript file and its source map a debug ID, appends the
 * snippet that registers the ID at runtime, and uploads the source maps to BugSplat.
 *
 * It does not change `devtool`. Use `source-map` or `hidden-source-map` (or, from webpack 5.97,
 * `source-map-debugids`, in which case webpack's own IDs are used).
 */
export class BugSplatWebpackPlugin implements WebpackPluginInstance {
  private warnedAboutSourceMaps = false;

  constructor(private readonly options: BugSplatOptions = {}) {}

  apply(compiler: Compiler): void {
    const { webpack } = compiler;

    const database = databaseToInline(this.options);
    if (database) {
      new webpack.DefinePlugin({ [DATABASE_EXPRESSION]: JSON.stringify(database) }).apply(compiler);
    }

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          // Straight after the stage in which webpack splits source maps into their own assets,
          // and before the stages that hash (realContentHash), compress and report assets, so
          // those all see the final content. Nothing is rewritten after the files are emitted.
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING + 1,
          // Also run for assets that other plugins add at later stages.
          additionalAssets: true,
        },
        (assets) => this.injectIntoAssets(compilation, Object.keys(assets)),
      );
    });

    compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, async (compilation) => {
      const error = await afterWrite({
        options: this.options,
        root: compiler.context,
        directory: compiler.outputPath,
        files: compilation.getAssets().map((asset) => withoutQuery(asset.name)),
        watchMode: compiler.watchMode,
      });
      if (error) {
        compilation.errors.push(new webpack.WebpackError(error.message));
      }
    });
  }

  private injectIntoAssets(compilation: Compilation, assetNames: string[]): void {
    const { RawSource } = compilation.compiler.webpack.sources;
    let count = 0;
    let javascriptFiles = 0;
    for (const name of assetNames) {
      if (!JAVASCRIPT_FILE.test(withoutQuery(name))) {
        continue;
      }
      javascriptFiles++;
      const asset = compilation.getAsset(name);
      // webpack records which asset is the source map of which file. Files without one (no
      // devtool, an eval or inline devtool) are skipped.
      const related = asset?.info.related?.sourceMap;
      const mapName = Array.isArray(related) ? related[0] : related;
      const mapAsset = mapName ? compilation.getAsset(mapName) : undefined;
      if (!asset || !mapName || !mapAsset) {
        continue;
      }
      const code = asset.source.source().toString();
      const map = mapAsset.source.source().toString();
      let result;
      try {
        result = injectDebugId(code, map);
      } catch {
        continue;
      }
      count++;
      if (result.code !== code) {
        compilation.updateAsset(name, new RawSource(result.code));
      }
      if (result.map !== map) {
        compilation.updateAsset(mapName, new RawSource(result.map));
      }
    }
    if (javascriptFiles && !count && !this.warnedAboutSourceMaps) {
      this.warnedAboutSourceMaps = true;
      (this.options.logger ?? consoleLogger).warn(
        'No source map files were emitted, so no debug IDs were added. Set devtool to source-map or hidden-source-map.',
      );
    }
  }
}

/** Creates the webpack plugin; the same as `new BugSplatWebpackPlugin(options)`. */
export function bugsplat(options: BugSplatOptions = {}): BugSplatWebpackPlugin {
  return new BugSplatWebpackPlugin(options);
}

export default bugsplat;
