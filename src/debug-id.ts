import { createHash } from 'node:crypto';

const NORMALISED_DEBUG_ID = /^[0-9a-f]{32}$/;

/**
 * Lowercases a debug ID and removes every hyphen. Returns undefined unless the result is exactly
 * 32 hexadecimal characters, so callers can treat anything else as "no ID".
 */
export function normaliseDebugId(id: unknown): string | undefined {
  if (typeof id !== 'string') {
    return undefined;
  }
  const normalised = id.toLowerCase().replace(/-/g, '');
  return NORMALISED_DEBUG_ID.test(normalised) ? normalised : undefined;
}

/**
 * Derives a debug ID from content: the same parts always give the same ID.
 *
 * The ID is the first 16 bytes of a SHA-256 digest, written as a lowercase hyphenated UUID with
 * the version (4) and variant bits set so that it passes UUID validation in other tools.
 */
export function deriveDebugId(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    // The length prefix keeps ("ab", "c") and ("a", "bc") from hashing to the same value.
    hash.update(`${Buffer.byteLength(part)}:`);
    hash.update(part);
  }
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const SNIPPET_BEFORE_ID =
  ';!function(){try{var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof global?global:self,n=(new e.Error).stack;n&&(e._debugIds=e._debugIds||{},e._debugIds[n]="';
const SNIPPET_AFTER_ID = '")}catch(e){}}();';

/**
 * The statement appended to each JavaScript file. When the file loads it records
 * `globalThis._debugIds[<stack string>] = <debug ID>`, where the first frame of the stack string
 * is the file itself.
 */
export function createRegistrationSnippet(debugId: string): string {
  return SNIPPET_BEFORE_ID + debugId + SNIPPET_AFTER_ID;
}

/**
 * Finds a registration snippet that is the last statement of `code`. Returns the code before it
 * and the ID it registers, or undefined when the code does not end with a snippet.
 */
export function splitRegistrationSnippet(code: string): { code: string; debugId: string } | undefined {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith(SNIPPET_AFTER_ID)) {
    return undefined;
  }
  const start = trimmed.lastIndexOf(SNIPPET_BEFORE_ID);
  if (start === -1) {
    return undefined;
  }
  const debugId = trimmed.slice(start + SNIPPET_BEFORE_ID.length, trimmed.length - SNIPPET_AFTER_ID.length);
  if (!/^[0-9a-fA-F-]+$/.test(debugId)) {
    return undefined;
  }
  // The snippet is written on a line of its own, so the line break before it goes too.
  const before = trimmed.slice(0, start);
  return { code: before.endsWith('\n') ? before.slice(0, -1) : before, debugId };
}
