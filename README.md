# @bugsplat/build

Build-tool plugins for [BugSplat](https://bugsplat.com) that make JavaScript stack traces readable without a separate upload step.

Add the plugin to Vite, Rollup or webpack and every build:

1. gives each emitted JavaScript file and its source map the same **debug ID** (a UUID),
2. appends a one-line snippet to each JavaScript file that records the file's debug ID when the file loads, so the BugSplat SDK can send the ID with an error report, and
3. uploads the source maps to your BugSplat database.

A debug ID ties a JavaScript file to the source map that was built with it. Stack traces in BugSplat then show original file names, line numbers and function names, even when two builds produce a file with the same name.

Use `@bugsplat/build` with a BugSplat SDK that reports debug IDs: [`bugsplat`](https://github.com/BugSplat-Git/bugsplat-js) for browsers and Node.js, or [`@bugsplat/electron`](https://github.com/BugSplat-Git/bugsplat-electron).

## Install

```sh
npm i -D @bugsplat/build
```

Node.js `^22.23.4`, `^24.22.1` or `>=26.12.1`. The bundlers are optional peer dependencies: Vite 6, 7 or 8, Rollup 4, webpack 5.

## Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import bugsplat from '@bugsplat/build/vite';

export default defineConfig({
  build: { sourcemap: true }, // or 'hidden'
  plugins: [bugsplat({ database: 'fred' })],
});
```

The plugin never turns source maps on for you. Set `build.sourcemap` to `true` or `'hidden'`; `'inline'` source maps have no file to upload and are skipped.

## Rollup

```js
// rollup.config.mjs
import bugsplat from '@bugsplat/build/rollup';

export default {
  input: 'src/main.js',
  output: { dir: 'dist', format: 'es', sourcemap: true },
  plugins: [bugsplat({ database: 'fred' })],
};
```

`@bugsplat/build/vite` also works in a Rollup config; `@bugsplat/build/rollup` has Rollup's own plugin type.

## webpack

```js
// webpack.config.mjs
import bugsplat from '@bugsplat/build/webpack';

export default {
  mode: 'production',
  devtool: 'source-map', // or 'hidden-source-map', or 'source-map-debugids' (webpack 5.97+)
  output: { clean: true },
  plugins: [bugsplat({ database: 'fred' })],
};
```

In a CommonJS config:

```js
// webpack.config.js
const { bugsplat } = require('@bugsplat/build/webpack');

module.exports = {
  mode: 'production',
  devtool: 'source-map',
  output: { clean: true },
  plugins: [bugsplat({ database: 'fred' })],
};
```

`new BugSplatWebpackPlugin(options)` is exported too. The plugin never changes `devtool`. With an `eval` or `inline` devtool, or with none, the plugin adds no debug IDs and logs one line that says so.

## Electron Forge (Vite template)

An Electron Forge app made from the Vite template has one Vite config per build: main process, preload script and renderer. Add the plugin to all three so that every JavaScript file the app loads has a debug ID.

```ts
// vite.main.config.mts
import { defineConfig } from 'vite';
import bugsplat from '@bugsplat/build/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [bugsplat({ deleteSourceMapsAfterUpload: true })],
});
```

```ts
// vite.preload.config.mts
import { defineConfig } from 'vite';
import bugsplat from '@bugsplat/build/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [bugsplat({ deleteSourceMapsAfterUpload: true })],
});
```

```ts
// vite.renderer.config.mts
import { defineConfig } from 'vite';
import bugsplat from '@bugsplat/build/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [bugsplat({ deleteSourceMapsAfterUpload: true })],
});
```

With no options beyond `deleteSourceMapsAfterUpload`, the three plugins read the database from the `BUGSPLAT_DATABASE` environment variable and the application name and version from the app's `package.json`. `deleteSourceMapsAfterUpload` keeps the `.map` files out of the packaged app.

In the main process, pass the database to the SDK as `process.env.BUGSPLAT_DATABASE`. The plugin replaces that expression with the database name at build time (see [`inlineDatabase`](#options)), so the packaged app does not need the environment variable:

```ts
// src/main.ts
import { init } from '@bugsplat/electron';

init({ database: process.env.BUGSPLAT_DATABASE! });
```

`@bugsplat/electron` reports Electron's `app.name` and `app.getVersion()` as the application and version. If your `package.json` has a `productName`, `app.name` is the `productName`, so pass the same string to the plugin as `application`.

`electron-forge start` builds the main process and the preload script in watch mode and serves the renderer from Vite's dev server; the plugin does not upload in watch mode. `electron-forge package` and `electron-forge make` run production builds, which upload.

## Uploading

The upload needs an [OAuth2 Client Credentials](https://docs.bugsplat.com/introduction/development/web-services/oauth2#client-credentials) client ID and client secret for your database. Provide the credentials as environment variables in CI and leave them unset on developer machines:

```yaml
# GitHub Actions
- run: npm run build
  env:
    BUGSPLAT_DATABASE: ${{ secrets.BUGSPLAT_DATABASE }}
    SYMBOL_UPLOAD_CLIENT_ID: ${{ secrets.SYMBOL_UPLOAD_CLIENT_ID }}
    SYMBOL_UPLOAD_CLIENT_SECRET: ${{ secrets.SYMBOL_UPLOAD_CLIENT_SECRET }}
```

- With a database, a client ID and a client secret, the plugin uploads the build's source maps after the bundle is written.
- Without them, the plugin skips the upload and logs one line that names the missing settings. Debug IDs are still added.
- In watch mode (`vite build --watch`, `webpack --watch`, a dev server) the plugin skips the upload unless `upload` is `true`.
- A failed upload logs one line and the build still succeeds. Set `failOnError: true` to fail the build instead.
- `dryRun: true` logs the source maps the plugin would upload and uploads nothing.

The plugin uploads the `.map` files that its own build wrote to the output directory. A `.map` file that an earlier build or another tool left there is not uploaded; [`uploadSourceMaps`](#other-build-tools) uploads every `.map` file below a directory.

Vite does not load `.env` files into `process.env` for the config file. If you keep the credentials in a `.env` file, load the file yourself (for example with `process.loadEnvFile()`) at the top of `vite.config.ts`.

## Options

Every option is optional.

| Option | Default | Description |
| --- | --- | --- |
| `database` | `process.env.BUGSPLAT_DATABASE` | BugSplat database name. |
| `application` | `name` in the project's `package.json` | Application name. Must match the application the SDK reports. |
| `version` | `version` in the project's `package.json` | Application version. Must match the version the SDK reports. |
| `clientId` | `process.env.SYMBOL_UPLOAD_CLIENT_ID` | OAuth2 Client Credentials client ID. |
| `clientSecret` | `process.env.SYMBOL_UPLOAD_CLIENT_SECRET` | OAuth2 Client Credentials client secret. |
| `host` | `process.env.BUGSPLAT_HOST`, then BugSplat's API | Base URL for authentication and upload requests. |
| `upload` | `true` when `database`, `clientId` and `clientSecret` are available and the bundler is not in watch mode | `false` never uploads. `true` uploads in watch mode too, and treats missing credentials as a failed upload. |
| `deleteSourceMapsAfterUpload` | `false` | Delete the `.map` files this build wrote once they are uploaded. The `//# sourceMappingURL=` comments stay; use hidden source maps if you do not want them. |
| `dryRun` | `false` | Log the source maps that would be uploaded; upload and delete nothing. |
| `inlineDatabase` | `true` | Replace `process.env.BUGSPLAT_DATABASE` in your source with the database name at build time (Vite `define`, webpack `DefinePlugin`, a transform in Rollup), so `init({ database: process.env.BUGSPLAT_DATABASE })` works on your users' machines. |
| `failOnError` | `false` | Fail the build when the upload fails. |
| `logger` | the console, each line prefixed with `[bugsplat]` | An object with `info`, `warn` and `error` methods that receives the plugin's log lines. |

Environment variables are read when the build runs, not when the config file calls `bugsplat()`.

## What the plugin changes in your files

The end of a JavaScript file after a build:

```js
…your code…
;!function(){try{var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof global?global:self,n=(new e.Error).stack;n&&(e._debugIds=e._debugIds||{},e._debugIds[n]="9f2c1a7e-3b4d-4c5e-8f60-112233445566")}catch(e){}}();
//# debugId=9f2c1a7e-3b4d-4c5e-8f60-112233445566
//# sourceMappingURL=index-BX3k2a9f.js.map
```

and its source map gains a top-level `"debugId": "9f2c1a7e-3b4d-4c5e-8f60-112233445566"`.

- **The ID.** If the bundler writes debug IDs itself, the plugin uses the bundler's ID. The plugin turns on `output.sourcemapDebugIds` in Rollup 4.25+ (including the Rollup inside Vite 6 and 7) and in Rolldown (Vite 8) unless you set the option yourself, and uses webpack's IDs when `devtool` is one of the `-debugids` variants. For every other file, including the worker files that Vite bundles separately, the plugin derives the ID from the content of the JavaScript file and its source map: the same content always gets the same ID.
- **The snippet.** The snippet runs when the file loads and stores the debug ID in `globalThis._debugIds`, the global that other debug ID tools also use, keyed by a stack trace whose first frame is the file. The snippet goes on a new line after your code. The plugin inserts nothing before or inside existing code, so every mapping in the source map stays valid.
- **Formats.** The comment and the `debugId` field follow the [TC39 source map debug ID proposal](https://github.com/tc39/ecma426/blob/main/proposals/debug-id.md).
- **Idempotent.** A file that already has its snippet, comment and map field is left untouched.
- **Files without a source map file are skipped.**

## Other build tools

The package's main entry point has the same steps as functions, for build tools that have no plugin here. Run them after the build tool has written its output:

```js
import { injectDebugIdsIntoDirectory, uploadSourceMaps } from '@bugsplat/build';

await injectDebugIdsIntoDirectory('dist');
await uploadSourceMaps({ directory: 'dist', database: 'fred' });
```

| Function | What it does |
| --- | --- |
| `injectDebugId(code, map)` | Takes JavaScript and its source map as strings and returns both with the debug ID, the snippet and the comment added. |
| `injectDebugIdIntoFile(file)` | Does the same for one `.js`, `.mjs` or `.cjs` file on disk and the source map file named by its `//# sourceMappingURL=` comment (or `<file>.map`). |
| `injectDebugIdsIntoDirectory(directory)` | Does the same for every JavaScript file below a directory, except in `node_modules` and dot-folders. |
| `uploadSourceMaps(options)` | Uploads every `.map` file below `options.directory`. Takes `database`, `application`, `version`, `clientId`, `clientSecret`, `host`, `deleteSourceMapsAfterUpload`, `dryRun` and `logger` with the defaults listed under [Options](#options), and rejects if the upload fails. |

`injectDebugIdIntoFile` and `injectDebugIdsIntoDirectory` rewrite files after the build tool has finished. Read the next section before using the two functions in a build that hashes or compresses its output.

## Things to know

**Hashes, compressed copies and precache manifests.** Adding the snippet changes a file's bytes, so anything computed from the file must be computed after the plugin has run.

- The Vite and Rollup plugins change chunks in the `generateBundle` hook, with `order: 'post'`, before any file is written. Plugins that read the written files (in `writeBundle` or `closeBundle`) see the final bytes. A plugin that hashes chunks inside its own `generateBundle` hook and runs before the BugSplat plugin (a Subresource Integrity plugin, for example) hashes the bytes without the snippet; give such a plugin `order: 'post'` and list it after `bugsplat()`, or use one that works from the written files. Rollup and Rolldown compute the `[hash]` in a chunk's file name before `generateBundle`, so the plugin adds the snippet to that hash in the `augmentChunkHash` hook: a build with the plugin gives its hashed chunks other names than a build without the plugin.
- The webpack plugin changes assets in the `processAssets` hook straight after webpack has split off the source maps, and before the stages in which webpack and other plugins compute content hashes, compress assets and report on them.
- If another plugin emits a JavaScript file, or rewrites a source map, after those hooks, the BugSplat plugin adds the missing debug ID to the written file and logs a warning that names the file. Subresource Integrity values, precompressed `.gz` or `.br` copies and service worker precache manifests made for a file named in that warning are out of date.
- `injectDebugIdIntoFile` and `injectDebugIdsIntoDirectory` always rewrite written files, so run the two functions before any step that hashes, compresses or signs the output.

**The snippet is the last statement of the file.** A file registers its debug ID once the file has run to the end. If a file throws while it is first evaluated, the error report for that throw carries no debug ID for the file. When a script's completion value matters (code passed to `eval`, `vm.runInContext` or a browser extension's `executeScript`), the completion value becomes the snippet's.

**Electron Forge writes the main and preload builds to one folder**, and runs the two builds at the same time. Each of the two plugins uploads only the source maps of its own build, and `deleteSourceMapsAfterUpload` deletes only those, so neither build reads or deletes a file of the other.

**Source maps in production.** Without `deleteSourceMapsAfterUpload`, the `.map` files stay in the output directory and are deployed with your site unless you remove them.

## Development

```sh
npm test            # builds real fixture apps with Vite 6, 7 and 8, Rollup 4 and webpack 5
npm run typecheck
npm run build       # ES module and CommonJS builds with types, in dist/
npm run test:dist   # loads every entry point of the built package both ways
```

## License

MIT
