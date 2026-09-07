#!/usr/bin/env node
// Measures what the page actually ships, raw / gzip / brotli, and separates the three.js cost
// from the application cost by building a probe that imports exactly the three.js classes
// src/globe.js imports and nothing else. Without that split, "the bundle is 168 KB" is a
// number nobody can act on.
//
// Run with `npm run measure` after `npm run build`.

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const TMP = join(ROOT, '.measure');

const gz = (b) => gzipSync(b, { level: 9 }).length;
const br = (b) => brotliCompressSync(b, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const sizes = (buf) => ({ raw: buf.length, gzip: gz(buf), brotli: br(buf) });
const posix = (p) => p.split('\\').join('/');

// Reads the real build's minifier so the probe is minified the same way.
function viteMinify() {
  const cfg = readFileSync(join(ROOT, 'vite.config.js'), 'utf8');
  const m = /minify:\s*'([a-z]+)'/.exec(cfg);
  return m ? m[1] : 'esbuild';
}

// Extracts the three.js import list straight from src/globe.js, so the probe can never drift
// from the real scene. A probe that measures a different import set measures nothing.
function threeImportsFromGlobe() {
  const src = readFileSync(join(ROOT, 'src', 'globe.js'), 'utf8');
  const out = [];
  const re = /^import\s*\{([^}]+)\}\s*from\s*'(three[^']*)';$/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ names: m[1].trim(), from: m[2] });
  return out;
}

export function main() {
  if (!existsSync(DIST)) throw new Error('dist/ not found. Run `npm run build` first.');

  const report = { measuredAt: new Date().toISOString(), shell: { files: [] }, payload: { files: [] } };

  // ---- What the browser downloads to boot the page --------------------------------------
  const walk = (dir, into, splitData) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (splitData && f === 'data') { walk(p, report.payload.files, false); continue; }
        walk(p, into, splitData);
        continue;
      }
      into.push({ file: posix(p.slice(DIST.length + 1)), ...sizes(readFileSync(p)) });
    }
  };
  walk(DIST, report.shell.files, true);

  const total = (arr) => arr.reduce((a, f) => ({
    raw: a.raw + f.raw, gzip: a.gzip + f.gzip, brotli: a.brotli + f.brotli,
  }), { raw: 0, gzip: 0, brotli: 0 });
  report.shell.total = total(report.shell.files);
  report.payload.total = total(report.payload.files);

  const js = report.shell.files.find((f) => f.file.endsWith('.js'));
  report.shell.javascript = js;
  report.shell.css = report.shell.files.find((f) => f.file.endsWith('.css'));
  report.shell.html = report.shell.files.find((f) => f.file.endsWith('.html'));

  // ---- Split three.js from the application ----------------------------------------------
  const imports = threeImportsFromGlobe();
  report.threeImports = imports;
  mkdirSync(TMP, { recursive: true });

  const probeLines = imports.map((i) => 'import { ' + i.names + " } from '" + i.from + "';");
  probeLines.push('// Reference every binding so nothing is shaken out as unused.');
  probeLines.push('globalThis.__probe = ['
    + imports.flatMap((i) => i.names.split(',').map((n) => n.trim())).join(', ') + '];');
  const NL = String.fromCharCode(10);
  writeFileSync(join(TMP, 'three-probe.js'), probeLines.join(NL) + NL);
  writeFileSync(join(TMP, 'index.html'),
    ['<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>',
      '<script type="module" src="./three-probe.js"></script>',
      '</body></html>'].join(NL) + NL);

  let threeOnly = null;
  try {
    // The probe MUST go through the SAME pipeline as the real bundle. Two earlier attempts
    // were invalid and both produced a probe LARGER than the whole app:
    //   1. esbuild, which shakes three's deep-import graph far less than Rollup does;
    //   2. Vite library mode, which silently skips minification for ES output even when
    //      build.minify is set, so the "probe" was unminified three.js.
    // So this builds an ordinary Vite app with an index.html entry, minifier and target
    // copied from the real config, and public/ excluded.
    const cfgLines = [
      "import { defineConfig } from 'vite';",
      'export default defineConfig({',
      "  root: '" + posix(TMP) + "',",
      '  publicDir: false,',
      '  build: {',
      "    target: 'es2020',",
      '    minify: ' + JSON.stringify(viteMinify()) + ',',
      '    terserOptions: { compress: { passes: 2 }, format: { comments: false } },',
      "    outDir: '" + posix(join(TMP, 'out')) + "',",
      '    emptyOutDir: true,',
      '    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } },',
      '  },',
      '});',
    ];
    writeFileSync(join(TMP, 'vite.probe.config.js'), cfgLines.join(NL) + NL);
    const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    execFileSync(process.execPath, [VITE, 'build', '--config', join(TMP, 'vite.probe.config.js'),
      '--logLevel', 'error'], { cwd: ROOT, stdio: 'pipe' });
    const assets = join(TMP, 'out', 'assets');
    const file = readdirSync(assets).find((f) => f.endsWith('.js'));
    threeOnly = sizes(readFileSync(join(assets, file)));
  } catch (err) {
    report.threeOnlyError = String((err && err.stderr && err.stderr.toString()) || err.message || err).slice(0, 600);
  }
  report.threeOnly = threeOnly;

  if (threeOnly && js) {
    const app = { raw: js.raw - threeOnly.raw, gzip: js.gzip - threeOnly.gzip, brotli: js.brotli - threeOnly.brotli };
    // A negative difference means the two builds are not comparable. Say so, rather than
    // printing a negative "application size" as though it meant something.
    report.application = (app.raw > 0 && app.gzip > 0)
      ? { ...app, note: 'Shipped bundle minus a three.js-only bundle built by the same bundler and minifier. Approximate: minifiers share strings across the whole graph.' }
      : { ...app, invalid: true, note: 'Negative difference, so this split is not reportable.' };
  }

  // ---- Budget ---------------------------------------------------------------------------
  const BUDGET = 165 * 1024;
  report.budget = {
    statedGzipBudgetBytes: BUDGET,
    source: 'SLATE-3D-DATASET.md section 5.1: about 138 KB of three.js plus about 27 KB of application.',
    javascriptGzip: js ? js.gzip : null,
    withinBudget: js ? js.gzip <= BUDGET : null,
    deltaBytes: js ? js.gzip - BUDGET : null,
  };

  // ---- The reference this project is measured against -------------------------------------
  // Measured, not quoted: scripts/measure-reference.mjs fetches the reference and compresses
  // it locally with the identical zlib settings used above. The brief's quoted 260,791 B gzip
  // came out at 260,993 B here, a 202 byte difference in compressor settings, which is exactly
  // why the comparison is re-measured rather than trusted.
  const refPath = join(ROOT, 'docs', 'reference-measurement.json');
  if (existsSync(refPath)) {
    const ref = JSON.parse(readFileSync(refPath, 'utf8'));
    report.reference = {
      url: ref.reference,
      measuredAt: ref.measuredAt,
      javascript: ref.javascript,
      shellTotal: ref.shellTotal,
      provenance: 'Fetched and measured locally by scripts/measure-reference.mjs.',
    };
    if (js) {
      const pct = (a, b) => +(100 * (a - b) / b).toFixed(1);
      report.comparison = {
        javascript: {
          dipmeter: { raw: js.raw, gzip: js.gzip, brotli: js.brotli },
          reference: { raw: ref.javascript.raw, gzip: ref.javascript.gzip, brotli: ref.javascript.brotli },
          rawPctVsReference: pct(js.raw, ref.javascript.raw),
          gzipPctVsReference: pct(js.gzip, ref.javascript.gzip),
        },
        shell: {
          dipmeter: report.shell.total,
          reference: ref.shellTotal,
          rawPctVsReference: pct(report.shell.total.raw, ref.shellTotal.raw),
          gzipPctVsReference: pct(report.shell.total.gzip, ref.shellTotal.gzip),
          brotliPctVsReference: pct(report.shell.total.brotli, ref.shellTotal.brotli),
        },
      };
    }
  } else {
    report.reference = { unavailable: 'Run node scripts/measure-reference.mjs (needs network).' };
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'bundle-report.json'), JSON.stringify(report, null, 2));

  const pad = (n) => String(n).padStart(10);
  const row = (label, s) => label.padEnd(36) + pad(s.raw) + pad(s.gzip) + pad(s.brotli) + '\n';
  let out = '';
  out += ' '.repeat(36) + pad('raw') + pad('gzip') + pad('brotli') + '\n';
  out += '-'.repeat(66) + '\n';
  for (const f of report.shell.files) out += row('  ' + f.file, f);
  out += row('SHELL TOTAL (boots the page)', report.shell.total);
  out += '\n';
  for (const f of report.payload.files) out += row('  data/' + f.file.replace(/^.*\//, ''), f);
  out += row('DATA PAYLOAD TOTAL', report.payload.total);
  out += '\n';
  if (threeOnly) {
    out += row('three.js alone (same import set)', threeOnly);
    if (report.application && !report.application.invalid) out += row('application code (difference)', report.application);
    else out += 'application code (difference)       NOT REPORTABLE: probe exceeded the app bundle\n';
  } else {
    out += 'three.js split unavailable: ' + (report.threeOnlyError || 'unknown') + '\n';
  }
  out += '\n';
  out += 'JS gzip: ' + report.budget.javascriptGzip + ' B against the stated ' + BUDGET
    + ' B ceiling -> ' + (report.budget.withinBudget
      ? 'within budget by ' + (-report.budget.deltaBytes) + ' B'
      : 'OVER by ' + report.budget.deltaBytes + ' B') + '\n';
  if (report.comparison) {
    const c = report.comparison;
    out += '\nAgainst ' + report.reference.url + ', measured the same way on '
      + report.reference.measuredAt.slice(0, 10) + ':\n';
    out += row('  reference JavaScript', c.javascript.reference);
    out += row('  dipmeter JavaScript', c.javascript.dipmeter);
    out += '  -> ' + c.javascript.rawPctVsReference + '% raw, '
      + c.javascript.gzipPctVsReference + '% gzip\n';
    out += row('  reference shell total', c.shell.reference);
    out += row('  dipmeter shell total', c.shell.dipmeter);
    out += '  -> ' + c.shell.rawPctVsReference + '% raw, ' + c.shell.gzipPctVsReference
      + '% gzip, ' + c.shell.brotliPctVsReference + '% brotli\n';
  } else {
    out += 'Reference not measured. Run node scripts/measure-reference.mjs.\n';
  }
  process.stdout.write(out);
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; }
}
