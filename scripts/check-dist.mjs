// Checks the built package (run `npm run build` first): every entry point named in package.json
// loads as both an ES module and a CommonJS module with the expected exports, and the CommonJS
// build of the Rollup plugin works in a real Rollup build.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

const expectedExports = {
  '.': [
    'createRegistrationSnippet',
    'deriveDebugId',
    'injectDebugId',
    'injectDebugIdIntoFile',
    'injectDebugIdsIntoDirectory',
    'normaliseDebugId',
    'uploadSourceMaps',
  ],
  './vite': ['bugsplat', 'default'],
  './rollup': ['bugsplat', 'default'],
  './webpack': ['BugSplatWebpackPlugin', 'bugsplat', 'default'],
};

for (const [subpath, names] of Object.entries(expectedExports)) {
  const target = packageJson.exports[subpath];
  for (const condition of ['import', 'require']) {
    const file = path.join(packageRoot, target[condition].default);
    assert.ok(readFileSync(path.join(packageRoot, target[condition].types), 'utf8').length > 0);
    const loaded = condition === 'import' ? await import(file) : require(file);
    const actual = Object.keys(loaded).filter((name) => name !== '__esModule' && name !== 'module.exports').sort();
    assert.deepEqual(actual, [...names].sort(), `${subpath} (${condition})`);
    if (names.includes('default')) {
      assert.equal(loaded.default, loaded.bugsplat, `${subpath} (${condition}): default export is bugsplat`);
    }
    console.log(`ok ${subpath} (${condition}): ${actual.join(', ')}`);
  }
}

// A real build with the CommonJS plugin, including the process.env.BUGSPLAT_DATABASE transform.
const { bugsplat } = require(path.join(packageRoot, packageJson.exports['./rollup'].require.default));
const outDir = mkdtempSync(path.join(tmpdir(), 'bugsplat-build-check-'));
try {
  const bundle = await rollup({
    input: path.join(packageRoot, 'test/fixtures/app/src/main.js'),
    plugins: [bugsplat({ database: 'fred', upload: false })],
  });
  await bundle.write({ dir: outDir, format: 'es', sourcemap: true });
  await bundle.close();
  const files = readdirSync(outDir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const code = readFileSync(path.join(outDir, name), 'utf8');
    const debugId = /\n\/\/# debugId=([0-9a-f-]{36})\n/.exec(code)?.[1];
    assert.ok(debugId, `${name} has a debugId comment`);
    assert.equal(JSON.parse(readFileSync(path.join(outDir, `${name}.map`), 'utf8')).debugId, debugId);
    assert.ok(!code.includes('process.env.BUGSPLAT_DATABASE'));
  }
  console.log(`ok Rollup build with the CommonJS plugin: ${files.join(', ')}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
