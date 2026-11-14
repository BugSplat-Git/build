import { beforeEach, vi } from 'vitest';

// No test may reach BugSplat: the adapter around @bugsplat/symbol-upload is replaced everywhere.
// (symbol-upload.test.ts loads the real adapter and replaces the package underneath it instead.)
vi.mock('../src/symbol-upload.js', () => ({
  uploadWithSymbolUpload: vi.fn(async () => undefined),
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
