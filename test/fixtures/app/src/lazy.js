import { formatGreeting } from './util.js';

export function explode(reason) {
  const message = formatGreeting(reason, 'lazy-chunk');
  // The next line is the one the source map test looks for.
  throw new Error('lazy-boom-token ' + message);
}
