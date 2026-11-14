import {
  createRegistrationSnippet,
  deriveDebugId,
  normaliseDebugId,
  splitRegistrationSnippet,
} from './debug-id.js';

/** Where the debug ID of a file came from. */
export type DebugIdOrigin =
  /** A `//# debugId=` comment that was already in the JavaScript (written by the bundler). */
  | 'comment'
  /** The `debugId` (or `debug_id`) field that was already in the source map. */
  | 'map'
  /** A registration snippet that was already the last statement of the JavaScript. */
  | 'snippet'
  /** Derived by this package from the content of the JavaScript and its source map. */
  | 'derived';

export interface InjectDebugIdResult {
  /** The JavaScript, ending with the registration snippet and the `//# debugId=` comment. */
  code: string;
  /** The source map JSON, with a top-level `debugId`. */
  map: string;
  /** The debug ID as written in the file. */
  debugId: string;
  origin: DebugIdOrigin;
  /** False when the JavaScript and the source map already had everything and are returned as given. */
  changed: boolean;
}

const SOURCE_MAPPING_URL_COMMENT = /^\/\/[#@]\s*sourceMappingURL=(\S+)$/;
const DEBUG_ID_COMMENT = /^\/\/#\s*debugId=(\S+)$/;

/** The source map debug ID proposal asks consumers to look for the comment in the last 5 lines. */
const DEBUG_ID_COMMENT_SEARCH_LINES = 5;

interface Trailer {
  /** Everything before the trailing block of blank lines and `//#` comments. */
  body: string;
  /** The `//# sourceMappingURL=` comment, when the file has one. */
  sourceMappingUrlComment?: string;
  /** The value of the `sourceMappingURL` comment. */
  sourceMappingUrl?: string;
  /** The valid debug ID in a trailing `//# debugId=` comment, as written. */
  debugId?: string;
}

/**
 * Splits JavaScript into its code and the block of `//# debugId=` and `//# sourceMappingURL=`
 * comments (and blank lines) that ends the file.
 */
export function splitTrailer(code: string): Trailer {
  const trailer: Trailer = { body: '' };
  let end = code.length;
  while (end > 0) {
    const lineStart = code.lastIndexOf('\n', end - 1) + 1;
    const line = code.slice(lineStart, end).trim();
    const sourceMappingUrl = SOURCE_MAPPING_URL_COMMENT.exec(line);
    const debugId = DEBUG_ID_COMMENT.exec(line);
    if (sourceMappingUrl) {
      // Browsers use the last sourceMappingURL comment in a file, which is the first one seen here.
      trailer.sourceMappingUrlComment ??= line;
      trailer.sourceMappingUrl ??= sourceMappingUrl[1];
    } else if (debugId) {
      if (normaliseDebugId(debugId[1])) {
        trailer.debugId ??= debugId[1];
      }
    } else if (line !== '') {
      break;
    }
    end = Math.max(lineStart - 1, 0);
  }
  trailer.body = code.slice(0, end).replace(/\r$/, '');
  return trailer;
}

/**
 * Looks for a `//# debugId=` comment that is within the last lines of the code but is followed by
 * something other than a `//#` comment (a footer added by another tool, for example). The comment
 * is blanked in place, so no line moves, and its ID is returned.
 */
function takeStrayDebugIdComment(body: string): { body: string; debugId?: string } {
  let end = body.length;
  for (let i = 0; i < DEBUG_ID_COMMENT_SEARCH_LINES - 1 && end > 0; i++) {
    const lineStart = body.lastIndexOf('\n', end - 1) + 1;
    const debugId = DEBUG_ID_COMMENT.exec(body.slice(lineStart, end).trim());
    if (debugId && normaliseDebugId(debugId[1])) {
      return { body: body.slice(0, lineStart) + body.slice(end), debugId: debugId[1] };
    }
    end = Math.max(lineStart - 1, 0);
  }
  return { body };
}

function readMapDebugId(map: Record<string, unknown>): string | undefined {
  for (const key of ['debugId', 'debug_id']) {
    const value = map[key];
    if (typeof value === 'string' && normaliseDebugId(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Makes sure a JavaScript file and its source map carry the same debug ID, and that the JavaScript
 * registers that ID when it loads.
 *
 * - The ID is the one in the file's `//# debugId=` comment if it has one, then the one in the
 *   source map, then the one in a registration snippet that already ends the file, and otherwise
 *   is derived from the content of the JavaScript and the source map.
 * - The registration snippet goes on a new line after the code, followed by `//# debugId=<id>` and
 *   then the file's `//# sourceMappingURL=` comment. Nothing is inserted before or inside the
 *   existing code, so every mapping in the source map (and every section offset of an index map)
 *   stays valid.
 * - Calling it again on its own output changes nothing.
 *
 * @param code The JavaScript.
 * @param map The JSON text of its source map.
 * @throws SyntaxError if `map` is not a JSON object.
 */
export function injectDebugId(code: string, map: string): InjectDebugIdResult {
  const parsedMap: unknown = JSON.parse(map);
  if (!parsedMap || typeof parsedMap !== 'object' || Array.isArray(parsedMap)) {
    throw new SyntaxError('The source map is not a JSON object');
  }
  const mapObject = parsedMap as Record<string, unknown>;

  const trailer = splitTrailer(code);
  const stray = trailer.debugId ? { body: trailer.body } : takeStrayDebugIdComment(trailer.body);
  const existingSnippet = splitRegistrationSnippet(stray.body);
  const body = existingSnippet ? existingSnippet.code : stray.body;

  const commentDebugId = trailer.debugId ?? stray.debugId;
  const mapDebugId = readMapDebugId(mapObject);
  let debugId: string;
  let origin: DebugIdOrigin;
  if (commentDebugId) {
    debugId = commentDebugId;
    origin = 'comment';
  } else if (mapDebugId) {
    debugId = mapDebugId;
    origin = 'map';
  } else if (existingSnippet && normaliseDebugId(existingSnippet.debugId)) {
    debugId = existingSnippet.debugId;
    origin = 'snippet';
  } else {
    debugId = deriveDebugId(body, map);
    origin = 'derived';
  }

  const lines = [];
  if (body !== '') {
    lines.push(body);
  }
  lines.push(createRegistrationSnippet(debugId), `//# debugId=${debugId}`);
  if (trailer.sourceMappingUrlComment) {
    lines.push(trailer.sourceMappingUrlComment);
  }
  const newCode = lines.join('\n') + (code.endsWith('\n') ? '\n' : '');

  let newMap = map;
  if (normaliseDebugId(mapObject.debugId) !== normaliseDebugId(debugId)) {
    // Assigning to an existing key keeps its position; a new key goes last, where magic-string
    // and the bundlers that write debug IDs themselves put it.
    mapObject.debugId = debugId;
    newMap = JSON.stringify(mapObject);
  }

  return { code: newCode, map: newMap, debugId, origin, changed: newCode !== code || newMap !== map };
}
