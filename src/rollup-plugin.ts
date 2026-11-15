import path from 'node:path';
import MagicString from 'magic-string';
import type { Plugin } from 'rollup';
import { afterWrite } from './after-write.js';
import { createRegistrationSnippet } from './debug-id.js';
import { injectDebugId } from './inject.js';
import { consoleLogger, DATABASE_EXPRESSION, databaseToInline, type BugSplatOptions } from './options.js';

const JAVASCRIPT_FILE = /\.[cm]?js$/;
const DATABASE_EXPRESSION_PATTERN = /(?<![\w$.])process\.env\.BUGSPLAT_DATABASE(?![\w$])/g;
const DATABASE_EXPRESSION_NAMES = DATABASE_EXPRESSION.split('.');

/** A node of the syntax tree that the bundler's `this.parse` returns. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** For each kind of node that writes to one of its children, the property that holds that child. */
const WRITTEN_CHILD: Record<string, string> = {
  AssignmentExpression: 'left',
  AssignmentPattern: 'left',
  ForInStatement: 'left',
  ForOfStatement: 'left',
  UpdateExpression: 'argument',
  RestElement: 'argument',
  ArrayPattern: 'elements',
  ObjectPattern: 'properties',
};

/** State the Vite entry point shares with the Rollup hooks. */
export interface PluginState {
  /** The project directory. Vite sets it from its resolved config. */
  root?: string;
  /** True when the bundler replaces `process.env.BUGSPLAT_DATABASE` itself (Vite's `define`). */
  databaseIsDefined: boolean;
}

/** The parts of an output chunk or asset that the plugin reads and writes. */
interface BundleItem {
  type: 'chunk' | 'asset';
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
  map?: { debugId?: string } | null;
  sourcemapFileName?: string | null;
}

function parseVersion(version: string | undefined): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * True when the bundler running the plugin can write debug IDs itself: Rollup from 4.25.0
 * (`output.sourcemapDebugIds`), or Rolldown from 1.0.0, which reports an older Rollup version for
 * compatibility and its own version next to it.
 */
function supportsSourcemapDebugIds(meta: { rollupVersion?: string; rolldownVersion?: string }): boolean {
  const rolldown = parseVersion(meta.rolldownVersion);
  if (rolldown) {
    return rolldown[0] >= 1;
  }
  const rollup = parseVersion(meta.rollupVersion);
  return !!rollup && (rollup[0] > 4 || (rollup[0] === 4 && rollup[1] >= 25));
}

function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof (value as AstNode).type === 'string';
}

/** True for the expression `process.env.BUGSPLAT_DATABASE`, written with dots and without `?.`. */
function isDatabaseExpression(node: unknown, depth = DATABASE_EXPRESSION_NAMES.length - 1): boolean {
  if (!isAstNode(node)) {
    return false;
  }
  if (depth === 0) {
    return node.type === 'Identifier' && node.name === DATABASE_EXPRESSION_NAMES[0];
  }
  const property = node.property;
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    !node.optional &&
    isAstNode(property) &&
    property.type === 'Identifier' &&
    property.name === DATABASE_EXPRESSION_NAMES[depth] &&
    isDatabaseExpression(node.object, depth - 1)
  );
}

/**
 * Collects the places below a node where `process.env.BUGSPLAT_DATABASE` is read. A place where
 * it is written to (the target of an assignment, the operand of `delete`) is not one of them.
 */
function findDatabaseReads(node: AstNode, written = false, reads: AstNode[] = []): AstNode[] {
  if (isDatabaseExpression(node)) {
    if (!written) {
      reads.push(node);
    }
    return reads;
  }
  for (const [key, value] of Object.entries(node)) {
    const childIsWritten =
      WRITTEN_CHILD[node.type] === key ||
      (node.type === 'UnaryExpression' && node.operator === 'delete') ||
      // A property of a destructuring pattern: its value is a target, its computed key is read.
      (written && node.type === 'Property' && key === 'value');
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isAstNode(child)) {
        findDatabaseReads(child, childIsWritten, reads);
      }
    }
  }
  return reads;
}

function sourceToString(source: string | Uint8Array | undefined): string {
  return typeof source === 'string' ? source : Buffer.from(source ?? '').toString('utf8');
}

/**
 * Gives every JavaScript file in the bundle that has a source map file its debug ID and
 * registration snippet. Returns how many files have one afterwards.
 */
function injectIntoBundle(bundle: Record<string, BundleItem>): number {
  let count = 0;
  for (const item of Object.values(bundle)) {
    const isChunk = item.type === 'chunk';
    if (!isChunk && !JAVASCRIPT_FILE.test(item.fileName)) {
      continue;
    }
    // Source maps are assets of their own in the bundle, and they, not `chunk.map`, are what is
    // written to disk. `sourcemap: 'inline'` has no such asset, so those files are skipped.
    const mapItem = bundle[(isChunk && item.sourcemapFileName) || `${item.fileName}.map`];
    if (!mapItem || mapItem.type !== 'asset') {
      continue;
    }
    const code = isChunk ? (item.code ?? '') : sourceToString(item.source);
    const map = sourceToString(mapItem.source);
    let result;
    try {
      result = injectDebugId(code, map);
    } catch {
      continue;
    }
    count++;
    if (result.code !== code) {
      if (isChunk) {
        item.code = result.code;
      } else {
        item.source = result.code;
      }
    }
    if (result.map !== map) {
      mapItem.source = result.map;
    }
    if (isChunk && item.map && item.map.debugId !== result.debugId) {
      item.map.debugId = result.debugId;
    }
  }
  return count;
}

export function createRollupPlugin(options: BugSplatOptions, state: PluginState): Plugin {
  let warnedAboutSourceMaps = false;

  return {
    name: 'bugsplat',

    // Ask the bundler to write debug IDs itself when it can. Files it leaves without one (and
    // every file, on older versions) get an ID derived from their content in generateBundle.
    outputOptions(outputOptions) {
      if (outputOptions.sourcemapDebugIds !== undefined || !supportsSourcemapDebugIds(this.meta)) {
        return null;
      }
      return { ...outputOptions, sourcemapDebugIds: true };
    },

    // Rollup has no `define`, so the plugin replaces process.env.BUGSPLAT_DATABASE itself. Under
    // Vite the `define` option does it and this hook does nothing.
    transform: {
      filter: { code: DATABASE_EXPRESSION },
      handler(code) {
        if (state.databaseIsDefined || !code.includes(DATABASE_EXPRESSION)) {
          return null;
        }
        const database = databaseToInline(options);
        if (!database) {
          return null;
        }
        const magicString = new MagicString(code);
        let reads;
        try {
          // Parsed, so that only code that reads the value is replaced. The same text in a string,
          // a template literal or a comment stays as written, and so does the target of an assignment.
          reads = findDatabaseReads(this.parse(code) as unknown as AstNode);
        } catch {
          // Not JavaScript yet: the plugin that compiles this module (TypeScript, JSX) is listed
          // after this one. The text is replaced wherever it occurs.
        }
        if (reads) {
          for (const read of reads) {
            magicString.overwrite(read.start, read.end, JSON.stringify(database));
          }
        } else {
          magicString.replaceAll(DATABASE_EXPRESSION_PATTERN, JSON.stringify(database));
        }
        if (!magicString.hasChanged()) {
          return null;
        }
        return { code: magicString.toString(), map: magicString.generateMap({ hires: true }) };
      },
    },

    // The bundler names a chunk by a hash of its content before generateBundle runs, so what is
    // appended there has to go into the hash here. Otherwise a build with the plugin would give
    // a file the name that a build without it, or with another version of the snippet, gave to
    // other bytes, and a cache that keeps hashed files for good would go on serving those. The
    // snippet is hashed without its ID, which is made from the finished chunk and not known yet.
    // The hook is not told whether the output has source maps, so it does this for every chunk.
    augmentChunkHash() {
      return createRegistrationSnippet('');
    },

    // `post`, so this runs after the other plugins (Vite's own included) have finished changing
    // chunks and their source maps. Changing the bundle here, before anything is written, means
    // the files on disk are final: nothing is rewritten after other tools have hashed them.
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle) {
        const count = injectIntoBundle(bundle as unknown as Record<string, BundleItem>);
        if (!count && !warnedAboutSourceMaps) {
          warnedAboutSourceMaps = true;
          (options.logger ?? consoleLogger).warn(
            'No source map files were emitted, so no debug IDs were added. Turn on source maps (not inline) in your bundler.',
          );
        }
      },
    },

    writeBundle: {
      order: 'post',
      sequential: true,
      async handler(outputOptions, bundle) {
        const directory = path.resolve(outputOptions.dir ?? path.dirname(outputOptions.file ?? '.'));
        const error = await afterWrite({
          options,
          root: state.root ?? process.cwd(),
          directory,
          files: Object.keys(bundle),
          watchMode: this.meta.watchMode,
        });
        if (error) {
          this.error(error.message);
        }
      },
    },
  };
}
