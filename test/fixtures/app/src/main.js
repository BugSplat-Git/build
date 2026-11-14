import { describeDatabase, formatGreeting } from './util.js';

// The dynamic import forces a second chunk. It is only called on demand so the
// entry file can be executed in Node without a DOM.
export async function loadLazy() {
  const lazy = await import('./lazy.js');
  return lazy.explode;
}

export function greet(name) {
  return formatGreeting(name, 'entry-greeting-token');
}

globalThis.__fixture = {
  loadLazy,
  greet,
  database: describeDatabase(process.env.BUGSPLAT_DATABASE, 'after-database-token'),
};
