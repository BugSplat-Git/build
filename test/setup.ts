import { beforeEach, vi } from 'vitest';

// No test may reach BugSplat: the adapter around @bugsplat/symbol-upload is replaced everywhere.
// (real-upload.test.ts opts out, and points the real adapter at a local HTTP server.)
vi.mock('../src/symbol-upload.js', () => ({
  uploadWithSymbolUpload: vi.fn(async () => []),
}));

const ENVIRONMENT_VARIABLES = [
  'BUGSPLAT_DATABASE',
  'BUGSPLAT_HOST',
  'SYMBOL_UPLOAD_CLIENT_ID',
  'SYMBOL_UPLOAD_CLIENT_SECRET',
];

// Whatever the developer's shell has set must not leak into the tests.
beforeEach(() => {
  for (const name of ENVIRONMENT_VARIABLES) {
    delete process.env[name];
  }
});
