import { describeDatabase, formatGreeting } from './util.js';

// The dynamic import forces a second chunk. It is only called on demand so the
// entry file can be executed in Node without a DOM.
export async function loadLazy() {
  const lazy = await import('./lazy.js');
  return lazy.explode;
}

// Vite and webpack bundle the worker into a file of its own.
export function startWorker() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

export function greet(name) {
  return formatGreeting(name, 'entry-greeting-token');
}

globalThis.__fixture = {
  loadLazy,
  startWorker,
  greet,
  database: describeDatabase(process.env.BUGSPLAT_DATABASE, 'after-database-token'),
};
