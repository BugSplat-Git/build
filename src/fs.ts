import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { injectDebugId, splitTrailer, type DebugIdOrigin } from './inject.js';

const JAVASCRIPT_FILE = /\.[cm]?js$/;

export interface InjectFileResult {
  /** Absolute path of the JavaScript file. */
  file: string;
  /** Absolute path of its source map. Undefined when the file was skipped for having none. */
  mapFile?: string;
  /** The file's debug ID. Undefined when the file was skipped. */
  debugId?: string;
  origin?: DebugIdOrigin;
  /** True when the JavaScript file, the source map, or both were rewritten. */
  changed: boolean;
  /** Why nothing was done: the file has no source map file next to it, or the map is not JSON. */
  skipped?: 'no-source-map' | 'invalid-source-map';
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

/**
 * The places a JavaScript file's source map can be, most specific first. With `sourceMaps`, only
 * the places that are in that set.
 */
function sourceMapCandidates(
  file: string,
  sourceMappingUrl: string | undefined,
  sourceMaps: ReadonlySet<string> | undefined,
): string[] {
  const candidates = [];
  if (sourceMappingUrl && !/^[a-z][a-z0-9+.-]*:/i.test(sourceMappingUrl) && !sourceMappingUrl.startsWith('//')) {
    const urlPath = sourceMappingUrl.replace(/[?#].*$/, '');
    try {
      candidates.push(path.resolve(path.dirname(file), decodeURIComponent(urlPath)));
    } catch {
      candidates.push(path.resolve(path.dirname(file), urlPath));
    }
  }
  candidates.push(`${file}.map`);
  return [...new Set(candidates)].filter((candidate) => !sourceMaps || sourceMaps.has(candidate));
}

/**
 * Gives one JavaScript file on disk and its source map a debug ID and the registration snippet;
 * see {@link injectDebugId}. The source map is the file named by the `//# sourceMappingURL=`
 * comment, or `<file>.map`. A file with no source map file (or an inline one) is left alone.
 *
 * Rewriting a file after the bundler has finished changes its content hash: Subresource Integrity
 * values, precompressed `.gz` or `.br` copies and service worker precache manifests computed
 * earlier no longer match. The bundler plugins avoid that by doing the same work inside the build.
 *
 * @param sourceMaps Absolute paths of the only files that count as a source map. A bundler plugin
 * passes the files its build emitted, so that a source map left in the output directory by an
 * earlier build, which describes other code, is never paired with the file. Default: any file.
 */
export async function injectDebugIdIntoFile(file: string, sourceMaps?: ReadonlySet<string>): Promise<InjectFileResult> {
  const jsFile = path.resolve(file);
  const code = await readFile(jsFile, 'utf8');
  const { sourceMappingUrl } = splitTrailer(code);

  for (const mapFile of sourceMapCandidates(jsFile, sourceMappingUrl, sourceMaps)) {
    const map = await readIfExists(mapFile);
    if (map === undefined) {
      continue;
    }
    let result;
    try {
      result = injectDebugId(code, map);
    } catch {
      return { file: jsFile, mapFile, changed: false, skipped: 'invalid-source-map' };
    }
    if (result.map !== map) {
      await writeFile(mapFile, result.map);
    }
    if (result.code !== code) {
      await writeFile(jsFile, result.code);
    }
    return { file: jsFile, mapFile, debugId: result.debugId, origin: result.origin, changed: result.changed };
  }
  return { file: jsFile, changed: false, skipped: 'no-source-map' };
}

/** Lists the files below a directory, skipping `node_modules` and entries whose name starts with a dot. */
export async function listFiles(directory: string, matches: (name: string) => boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath, matches)));
    } else if (entry.isFile() && matches(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Runs {@link injectDebugIdIntoFile} on every `.js`, `.mjs` and `.cjs` file below a directory
 * (`node_modules` and dot-folders excepted). Use it after a build tool that has no plugin here.
 * Resolves with one result per JavaScript file, including the ones that were skipped.
 */
export async function injectDebugIdsIntoDirectory(directory: string): Promise<InjectFileResult[]> {
  const files = await listFiles(path.resolve(directory), (name) => JAVASCRIPT_FILE.test(name));
  const results = [];
  for (const file of files) {
    results.push(await injectDebugIdIntoFile(file));
  }
  return results;
}
