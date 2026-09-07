#!/usr/bin/env node
// Fetches the reference this project is measured against and measures it, so the comparison
// in the README is a measurement rather than a quotation. Writes docs/reference-measurement.json.
//
// Run with `node scripts/measure-reference.mjs`. Requires network.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REFERENCE = 'https://human-atlas-seven.vercel.app/';

const gz = (b) => gzipSync(b, { level: 9 }).length;
const br = (b) => brotliCompressSync(b, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;

async function grab(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, raw: buf.length, gzip: gz(buf), brotli: br(buf) };
}

export async function main() {
  const htmlRes = await fetch(REFERENCE);
  if (!htmlRes.ok) throw new Error('reference: HTTP ' + htmlRes.status);
  const html = await htmlRes.text();
  const htmlBuf = Buffer.from(html);

  // The reference is a Vite single page application: one hashed JS asset and one hashed CSS
  // asset referenced from a tiny index.html.
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const files = [{ url: REFERENCE, kind: 'html', raw: htmlBuf.length, gzip: gz(htmlBuf), brotli: br(htmlBuf) }];
  for (const a of assets) {
    const r = await grab(new URL(a, REFERENCE).href);
    files.push({ ...r, kind: a.endsWith('.css') ? 'css' : 'js' });
  }

  const sum = files.reduce((acc, f) => ({
    raw: acc.raw + f.raw, gzip: acc.gzip + f.gzip, brotli: acc.brotli + f.brotli,
  }), { raw: 0, gzip: 0, brotli: 0 });

  const report = {
    measuredAt: new Date().toISOString(),
    reference: REFERENCE,
    method: 'Fetched over HTTPS and compressed locally with node:zlib at gzip level 9 and brotli quality 11, the same settings scripts/measure-bundle.mjs uses for dipmeter, so the two are comparable.',
    files,
    shellTotal: sum,
    javascript: files.find((f) => f.kind === 'js') || null,
  };
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'reference-measurement.json'), JSON.stringify(report, null, 2));

  const pad = (n) => String(n).padStart(10);
  process.stdout.write(' '.repeat(30) + pad('raw') + pad('gzip') + pad('brotli') + '\n');
  for (const f of files) {
    process.stdout.write(('  ' + f.kind).padEnd(30) + pad(f.raw) + pad(f.gzip) + pad(f.brotli) + '\n');
  }
  process.stdout.write('SHELL TOTAL'.padEnd(30) + pad(sum.raw) + pad(sum.gzip) + pad(sum.brotli) + '\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
