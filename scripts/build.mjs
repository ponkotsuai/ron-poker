// Builds:
//  - assets/app.js: the game bundle served by GitHub Pages (index.html loads it)
//  - dist/preview.html: one self-contained page for a Claude artifact preview (practice mode only)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';

const common = {
  entryPoints: ['js/main.js'], bundle: true, minify: true, target: 'es2020', platform: 'browser',
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  inject: ['scripts/shims.js'],
};

await build({ ...common, format: 'esm', outfile: 'assets/app.js', define: { ...common.define, __PREVIEW__: 'false' } });

// Version the bundle URL so browsers pick up a new build at once.
const version = createHash('sha256').update(readFileSync('assets/app.js')).digest('hex').slice(0, 10);
const html = readFileSync('index.html', 'utf8').replace(/src="assets\/app\.js[^"]*"/, `src="assets/app.js?v=${version}"`);
writeFileSync('index.html', html);
const body = html.split('<!--BODY-->')[1].split('<!--/BODY-->')[0];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const css = readFileSync('css/style.css', 'utf8');
const js = await build({ ...common, format: 'iife', write: false, define: { ...common.define, __PREVIEW__: 'true' } });
mkdirSync('dist', { recursive: true });
// The preview loads the character art from next to itself.
cpSync('assets/chars', 'dist/assets/chars', { recursive: true });
cpSync('assets/title.webp', 'dist/assets/title.webp');
writeFileSync('dist/preview.html', `<title>Ron Poker</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
${body}
<script>
${js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}
</script>
`);
console.log('built assets/app.js and dist/preview.html');
