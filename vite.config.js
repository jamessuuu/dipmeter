import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKER = '<!--DIPMETER_FALLBACK-->';

// The no-JavaScript twin has to be in the SERVED markup, not injected at runtime, or the
// whole point of it is lost. This plugin substitutes the generated partial into index.html
// at transform time, for `vite dev` and `vite build` alike, and fails the build loudly if
// the partial has not been generated.
function fallbackPlugin() {
  return {
    name: 'dipmeter-fallback',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const path = join(ROOT, 'src', 'fallback.generated.html');
        if (!existsSync(path)) {
          throw new Error('src/fallback.generated.html is missing. Run `npm run build:fallback` first.');
        }
        const partial = readFileSync(path, 'utf8');
        if (!html.includes(MARKER)) throw new Error('index.html no longer contains ' + MARKER);
        return html.replace(MARKER, partial);
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [fallbackPlugin()],
  build: {
    target: 'es2020',
    // terser over esbuild: measurably smaller here, and this project publishes its bundle
    // size as a headline number, so the cheapest honest byte is worth taking.
    minify: 'terser',
    terserOptions: { compress: { passes: 2 }, format: { comments: false } },
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // One JS file, so "the bundle size" is an unambiguous number rather than a sum the
        // reader has to assemble from a chunk graph.
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
