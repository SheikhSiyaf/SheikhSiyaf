// Puts the demo build (web/dist-demo, sample data held in the browser, no database) inside the web build at
// web/dist/preview, so the live site can open it from the platform owner's Demo mode button. To take the demo off the
// live site, remove this step from `build:prod` (package.json): nothing else changes and no data is involved.
import { cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const from = path.join(root, 'web/dist-demo'), to = path.join(root, 'web/dist/preview');
await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true, filter: (src) => !src.endsWith('nusuh-books-demo.html') });
console.log('Demo preview placed at web/dist/preview');
