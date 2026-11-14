import { formatGreeting } from './util.js';

self.onmessage = (event) => {
  self.postMessage(formatGreeting(event.data, 'worker-reply-token'));
};
