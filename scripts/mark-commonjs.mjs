// The package is "type": "module", so the CommonJS build needs a package.json of its own that
// tells Node (and TypeScript) the .js and .d.ts files in dist/cjs are CommonJS.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{\n  "type": "commonjs"\n}\n');
