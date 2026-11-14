// Executes one built file in this (fresh) Node process and prints globalThis._debugIds as JSON.
// Usage: node run-file.mjs <module|commonjs|script> <file>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const [mode, file] = process.argv.slice(2);

// webpack's browser runtime reaches for `self`.
globalThis.self = globalThis;

if (mode === 'module') {
  await import(pathToFileURL(file).href);
} else if (mode === 'commonjs') {
  createRequire(import.meta.url)(file);
} else {
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
}

process.stdout.write(JSON.stringify(globalThis._debugIds ?? {}));
