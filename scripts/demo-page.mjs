// Turns the demo build (web/dist-demo) into one self-contained HTML file that can be opened
// anywhere, including as a published page in the Claude app: web/dist-demo/nusuh-books-demo.html
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../web/dist-demo');
const html = await readFile(path.join(dir, 'index.html'), 'utf8');
const js = /<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/.exec(html)?.[1];
const css = /<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/.exec(html)?.[1];
if (!js || !css) throw new Error('Unexpected build output: run `vite build --mode demo` first.');
const script = (await readFile(path.join(dir, js), 'utf8')).replaceAll('</script', '<\\/script');
const style = await readFile(path.join(dir, css), 'utf8');

const page = `<title>Nusuh Books</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${style}</style>
<div id="root"></div>
<script type="module">${script}</script>
`;
await writeFile(path.join(dir, 'nusuh-books-demo.html'), page);
console.log(`Wrote web/dist-demo/nusuh-books-demo.html (${Math.round(page.length / 1024)} KB)`);
