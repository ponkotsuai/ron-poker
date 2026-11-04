// Builds a single self-contained page (CSS + bundled JS inline) for previewing as a Claude artifact.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const body = html.split('<!--BODY-->')[1].split('<!--/BODY-->')[0];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const css = readFileSync('css/style.css', 'utf8');
const js = await build({ entryPoints: ['js/main.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' });
const out = `<title>Ron Poker</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
${body}
<script>
${js.outputFiles[0].text}
</script>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/preview.html', out);
console.log('dist/preview.html', out.length, 'bytes');
