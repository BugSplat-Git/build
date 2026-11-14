import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { expect } from 'vitest';
import { createRegistrationSnippet, normaliseDebugId } from '../src/debug-id.js';
import type { Logger } from '../src/options.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

export const fixtureRoot = path.join(testDirectory, 'fixtures', 'app');
const outputRoot = path.join(testDirectory, '.output');
const runFileScript = path.join(testDirectory, 'run-file.mjs');

/** An empty directory for one build's output. */
export function outputDirectory(name: string): string {
  const directory = path.join(outputRoot, name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function createTestLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: Logger = {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  };
  return { logger, lines };
}

export interface BuiltFile {
  /** Path relative to the output directory, with forward slashes. */
  name: string;
  file: string;
  code: string;
  mapFile: string;
  map: Record<string, unknown>;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(entryPath) : [entryPath];
    });
}

/** Every JavaScript file below a directory that has a `.map` file next to it, read from disk. */
export function readBuiltFiles(directory: string): BuiltFile[] {
  return walk(directory)
    .filter((file) => /\.[cm]?js$/.test(file) && existsSync(`${file}.map`))
    .map((file) => ({
      name: path.relative(directory, file).split(path.sep).join('/'),
      file,
      code: readFileSync(file, 'utf8'),
      mapFile: `${file}.map`,
      map: JSON.parse(readFileSync(`${file}.map`, 'utf8')) as Record<string, unknown>,
    }));
}

export function listSourceMaps(directory: string): string[] {
  return walk(directory).filter((file) => file.endsWith('.map'));
}

const DEBUG_ID_COMMENT = /^\/\/# debugId=(.+)$/;

/**
 * Asserts that a file on disk has exactly one `//# debugId=` comment, in its last 5 lines, that
 * the source map carries the same ID, and that the registration snippet is there once, on the
 * line above the comment. Returns the ID.
 */
export function expectDebugId(built: BuiltFile): string {
  const lines = built.code.split('\n');
  const commentLines = lines.flatMap((line, index) => (DEBUG_ID_COMMENT.test(line) ? [index] : []));
  expect(commentLines, `${built.name}: one debugId comment`).toHaveLength(1);
  const commentLine = commentLines[0]!;
  expect(commentLine, `${built.name}: debugId comment in the last 5 lines`).toBeGreaterThanOrEqual(lines.length - 5);

  const debugId = DEBUG_ID_COMMENT.exec(lines[commentLine]!)![1]!;
  expect(debugId, `${built.name}: canonical UUID`).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(normaliseDebugId(debugId)).toMatch(/^[0-9a-f]{32}$/);
  expect(built.map.debugId, `${built.name}: map debugId`).toBe(debugId);

  const snippet = createRegistrationSnippet(debugId);
  expect(built.code.split(snippet), `${built.name}: one registration snippet`).toHaveLength(2);
  expect(built.code.split('_debugIds[n]='), `${built.name}: one registration of any ID`).toHaveLength(2);
  expect(lines[commentLine - 1], `${built.name}: snippet on the line above the comment`).toBe(snippet);

  const sourceMappingUrlLines = lines.flatMap((line, index) => (line.startsWith('//# sourceMappingURL=') ? [index] : []));
  expect(sourceMappingUrlLines.length).toBeLessThanOrEqual(1);
  if (sourceMappingUrlLines.length) {
    expect(sourceMappingUrlLines[0], `${built.name}: debugId comment above sourceMappingURL`).toBe(commentLine + 1);
  }
  return debugId;
}

export type RunMode = 'module' | 'commonjs' | 'script';

/**
 * Executes a file from disk in a fresh Node process, as an ES module, a CommonJS module or a
 * classic script, and returns the `globalThis._debugIds` it leaves behind.
 */
export function runFile(file: string, mode: RunMode): Record<string, string> {
  const output = execFileSync(process.execPath, [runFileScript, mode, file], { encoding: 'utf8' });
  return JSON.parse(output) as Record<string, string>;
}

/** Asserts that executing the file registers its ID under a stack whose first frame is the file. */
export function expectRegistration(built: BuiltFile, debugId: string, mode: RunMode): void {
  const debugIds = runFile(built.file, mode);
  const entries = Object.entries(debugIds).filter(([, id]) => id === debugId);
  expect(entries, `${built.name}: registered once`).toHaveLength(1);
  const [stack] = entries[0]!;
  const firstFrame = stack.split('\n').find((line) => line.trim().startsWith('at '));
  expect(firstFrame, `${built.name}: first frame is the file`).toContain(path.basename(built.file));
}

/**
 * Finds a token in a built file, maps its position back through the source map on disk, and
 * asserts that it lands on the line of the original source file that contains the token.
 */
export function expectTokenMapsToSource(files: BuiltFile[], token: string, sourceFile: string): void {
  const built = files.find((candidate) => candidate.code.includes(token));
  expect(built, `a built file contains ${token}`).toBeDefined();
  const index = built!.code.indexOf(token);
  const before = built!.code.slice(0, index).split('\n');
  const generated = { line: before.length, column: before[before.length - 1]!.length };

  const sourceLines = readFileSync(path.join(fixtureRoot, 'src', sourceFile), 'utf8').split('\n');
  const expectedLine = sourceLines.findIndex((line) => line.includes(token)) + 1;
  expect(expectedLine).toBeGreaterThan(0);
  // The token sits inside a string literal; the mapping points at the literal's opening quote.
  const expectedColumn = sourceLines[expectedLine - 1]!.indexOf(token) - 1;

  const original = originalPositionFor(new TraceMap(JSON.stringify(built!.map)), generated);
  expect(original.source, `${token} maps to ${sourceFile}`).toMatch(new RegExp(`(^|/)${sourceFile.replace('.', '\\.')}$`));
  expect(original.line, `${token} maps to line ${expectedLine} of ${sourceFile}`).toBe(expectedLine);
  expect(original.column, `${token} maps to column ${expectedColumn} of that line`).toBe(expectedColumn);
}

/** File name without its content hash, so the same file can be found in two builds. */
export function debugIdsByName(files: BuiltFile[]): Record<string, string> {
  return Object.fromEntries(files.map((built) => [built.name, String(built.map.debugId)]));
}
