#!/usr/bin/env node
// Recomputes every headline number from the data on disk and checks it against what the page
// actually ships, so a figure in the UI can never quietly go stale. Exits non-zero on any
// mismatch. Run with `npm run verify`.
//
// This deliberately re-derives from the RAW sources rather than trusting manifest.json, and
// then separately decodes the SHIPPED binaries, so a bug in the packer shows up as a
// disagreement between the two rather than as two copies of the same wrong number.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readCatalogue, DEFAULT_DEPTHS } from './lib/comcat.mjs';
import { listZones, readGrid } from './lib/slab2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = join(ROOT, 'data', 'raw');
const PUB = join(ROOT, 'public', 'data');
const DIST = join(ROOT, 'dist');

const results = [];
let failures = 0;

function check(label, actual, expected, note) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  results.push({ ok, label, actual, expected, note });
  return ok;
}

function record(label, value, note) {
  results.push({ ok: true, label, actual: value, expected: value, note, informational: true });
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

function decodeEvents(file) {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);
  const magic = view.getUint32(0, true);
  if (magic !== 0x45504944) throw new Error(file + ' bad magic');
  const n = view.getUint32(8, true);
  let o = 16;
  const lat = new Int16Array(ab, o, n); o += n * 2;
  const lon = new Int16Array(ab, o, n); o += n * 2;
  const depth = new Uint16Array(ab, o, n); o += n * 2;
  const month = new Uint16Array(ab, o, n); o += n * 2;
  const region = new Uint16Array(ab, o, n); o += n * 2;
  const mag = new Uint8Array(ab, o, n); o += n;
  const flags = new Uint8Array(ab, o, n); o += n;
  const zone = new Uint8Array(ab, o, n); o += n;
  if (o !== ab.byteLength) throw new Error(file + ' length mismatch: header describes ' + o + ', file is ' + ab.byteLength);
  return { n, lat, lon, depth, month, region, mag, flags, zone, bytes: ab.byteLength };
}

export function main() {
  const manifest = JSON.parse(readFileSync(join(PUB, 'manifest.json'), 'utf8'));
  const ENC = manifest.encoding;

  // ---- 1. Re-derive from the raw CSV --------------------------------------------------
  const csvPath = join(RAW, 'comcat-m45-1990-2026.csv');
  const csvBytes = statSync(csvPath).size;
  const { events: parsedAll, totalLines } = readCatalogue(csvPath);
  const kept = parsedAll.filter((e) => e.mag >= 4.5);
  // Apply the SAME quantisation the packer applies, independently re-derived here from the
  // manifest's declared constants, so this check tests the packer rather than echoing it.
  for (const e of kept) {
    e.depth = Math.round((e.depth + ENC.DEPTH_OFFSET) * ENC.DEPTH_SCALE) / ENC.DEPTH_SCALE - ENC.DEPTH_OFFSET;
    e.mag = Math.round(e.mag * 10) / 10;
  }

  record('ComCat CSV, measured bytes on disk', csvBytes);
  record('ComCat CSV, data rows', totalLines);
  check('Manifest csvBytes matches the file', manifest.sources.comcat.csvBytes, csvBytes);
  check('Manifest dataRows matches the file', manifest.sources.comcat.dataRows, totalLines);
  check('Events kept after the M4.5 floor', manifest.counts.events, kept.length);
  check('Events dropped below the M4.5 floor',
    manifest.sources.comcat.droppedBelowMagnitudeFloor.count, parsedAll.length - kept.length);

  let shallow = 0, intermediate = 0, deep = 0, deeper500 = 0, aboveSea = 0, atDefault = 0, notEq = 0;
  let dMin = Infinity, dMax = -Infinity, mMin = Infinity, mMax = -Infinity;
  for (const e of kept) {
    if (e.depth < 70) shallow += 1; else if (e.depth < 300) intermediate += 1; else deep += 1;
    if (e.depth > 500) deeper500 += 1;
    if (e.depth < 0) aboveSea += 1;
    for (const d of DEFAULT_DEPTHS) if (Math.abs(e.depth - d) < 1e-9) { atDefault += 1; break; }
    if (e.type !== 'earthquake') notEq += 1;
    if (e.depth < dMin) dMin = e.depth;
    if (e.depth > dMax) dMax = e.depth;
    if (e.mag < mMin) mMin = e.mag;
    if (e.mag > mMax) mMax = e.mag;
  }
  check('Shallow, 0 to 70 km', manifest.counts.regimes.shallow, shallow);
  check('Intermediate, 70 to 300 km', manifest.counts.regimes.intermediate, intermediate);
  check('Deep, 300 to 800 km', manifest.counts.regimes.deep, deep);
  check('Deeper than 500 km', manifest.counts.regimes.deeperThan500, deeper500);
  check('Above sea level', manifest.counts.aboveSeaLevel, aboveSea);
  check('At an assigned default depth', manifest.counts.defaultDepth, atDefault);
  check('Not of catalogue type earthquake', manifest.counts.notEarthquake, notEq);
  check('Minimum depth, km', manifest.counts.depthKm.min, +dMin.toFixed(2));
  check('Maximum depth, km', manifest.counts.depthKm.max, +dMax.toFixed(2));
  check('Minimum magnitude', manifest.counts.magnitude.min, +mMin.toFixed(2));
  check('Maximum magnitude', manifest.counts.magnitude.max, +mMax.toFixed(2));
  check('Regimes sum to the total', shallow + intermediate + deep, kept.length);

  // ---- 2. Slab2 -----------------------------------------------------------------------
  const xyzDir = join(RAW, 'slab2-xyz');
  const grdDir = join(RAW, 'slab2');
  const nodeDir = join(RAW, 'slab2-nodes');
  const zones = listZones(xyzDir);
  check('Slab2 zones on disk', manifest.zones.length, zones.length);
  const grdFiles = readdirSync(grdDir).filter((f) => f.endsWith('.grd'));
  const grdBytes = grdFiles.reduce((a, f) => a + statSync(join(grdDir, f)).size, 0);
  record('Slab2 depth grids, count', grdFiles.length);
  record('Slab2 depth grids, measured bytes', grdBytes);

  const supFiles = existsSync(nodeDir) ? readdirSync(nodeDir).filter((f) => f.endsWith('.csv')) : [];
  check('Zones with supplementary node files, i.e. overturning',
    manifest.sources.slab2.overturningZones.length, supFiles.length);
  record('Overturning zones', manifest.sources.slab2.overturningZones.map((z) => z.code).join(' '));

  // Every shipped grid's geometry must match the source it was decimated from.
  let gridMismatch = 0;
  for (const z of manifest.zones) {
    const file = zones.find((x) => x.code === z.code);
    if (!file) { gridMismatch += 1; continue; }
    const g = readGrid(join(xyzDir, file.file));
    if (g.nx !== z.sourceNx || g.ny !== z.sourceNy || Math.abs(g.step - z.sourceStep) > 1e-9
      || g.rows !== z.sourceNodes || g.valid !== z.sourceValidNodes) gridMismatch += 1;
  }
  check('Shipped slab grids that disagree with their source', gridMismatch, 0);

  // ---- 3. The shipped binaries ---------------------------------------------------------
  const a = decodeEvents(join(PUB, 'events-a.bin'));
  const b = decodeEvents(join(PUB, 'events-b.bin'));
  check('Tier A + tier B equals the total', a.n + b.n, kept.length);
  check('Manifest tier A count', manifest.counts.tierA, a.n);
  check('Manifest tier B count', manifest.counts.tierB, b.n);

  // Decode the binaries back to real units and confirm they still describe the same Earth.
  let binShallow = 0, binIntermediate = 0, binDeep = 0, binAssigned = 0, binAbove = 0;
  let binDepthMin = Infinity, binDepthMax = -Infinity;
  let binMagMin = Infinity, binMagMax = -Infinity;
  const zoneCounts = new Array(manifest.zones.length + 1).fill(0);
  for (const t of [a, b]) {
    for (let i = 0; i < t.n; i += 1) {
      const d = t.depth[i] / ENC.DEPTH_SCALE - ENC.DEPTH_OFFSET;
      const m = (t.mag[i] + ENC.MAG_TENTHS_OFFSET) / 10;
      if (d < 70) binShallow += 1; else if (d < 300) binIntermediate += 1; else binDeep += 1;
      if (d < 0) binAbove += 1;
      if (t.flags[i] & 1) binAssigned += 1;
      if (d < binDepthMin) binDepthMin = d;
      if (d > binDepthMax) binDepthMax = d;
      if (m < binMagMin) binMagMin = m;
      if (m > binMagMax) binMagMax = m;
      zoneCounts[t.zone[i]] += 1;
    }
  }
  check('Binary shallow count equals the CSV', binShallow, shallow);
  check('Binary intermediate count equals the CSV', binIntermediate, intermediate);
  check('Binary deep count equals the CSV', binDeep, deep);
  check('Binary above-sea-level count equals the CSV', binAbove, aboveSea);
  check('Binary assigned-depth count equals the CSV', binAssigned, atDefault);
  check('Binary minimum depth round-trips', +binDepthMin.toFixed(2), +dMin.toFixed(2));
  check('Binary maximum depth round-trips', +binDepthMax.toFixed(2), +dMax.toFixed(2));
  check('Binary minimum magnitude round-trips', +binMagMin.toFixed(2), +mMin.toFixed(2));
  check('Binary maximum magnitude round-trips', +binMagMax.toFixed(2), +mMax.toFixed(2));
  check('Binary unattributed count equals the manifest', zoneCounts[0], manifest.counts.unattributed);
  check('Attributed plus unattributed equals the total',
    manifest.counts.attributedToASlab + manifest.counts.unattributed, kept.length);

  let zoneSumOk = 0;
  for (let i = 0; i < manifest.zones.length; i += 1) {
    if (manifest.zones[i].events === zoneCounts[i + 1]) zoneSumOk += 1;
  }
  check('Per-zone counts that match the binary', zoneSumOk, manifest.zones.length);

  // Region index
  check('Region ids in range', [...a.region, ...b.region].every((r) => r < manifest.regions.length), true);
  const regionSum = manifest.regions.reduce((s, r) => s + r.count, 0);
  check('Region counts sum to the total', regionSum, kept.length);

  // ---- 4. Payload and bundle sizes ------------------------------------------------------
  const gz = (buf) => gzipSync(buf, { level: 9 }).length;
  const br = (buf) => brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;

  const payloadFiles = ['events-a.bin', 'events-b.bin', 'slabs.bin', 'coast.bin'];
  let payloadRaw = 0, payloadGz = 0, payloadBr = 0;
  for (const f of payloadFiles) {
    const buf = readFileSync(join(PUB, f));
    payloadRaw += buf.length;
    payloadGz += gz(buf);
    payloadBr += br(buf);
    check(f + ' raw bytes match the manifest', manifest.payload[f].raw, buf.length);
  }
  record('Data payload raw bytes', payloadRaw);
  record('Data payload gzip bytes', payloadGz);
  record('Data payload brotli bytes', payloadBr);

  const bundle = { raw: 0, gzip: 0, brotli: 0, files: [] };
  if (existsSync(DIST)) {
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f === 'data') continue; // the data payload is measured separately, above
          walk(p);
          continue;
        }
        const buf = readFileSync(p);
        bundle.raw += buf.length;
        bundle.gzip += gz(buf);
        bundle.brotli += br(buf);
        bundle.files.push({ file: p.slice(DIST.length + 1).replace(/\\/g, '/'), raw: buf.length, gzip: gz(buf), brotli: br(buf) });
      }
    };
    walk(DIST);
    record('Shipped shell (HTML + CSS + JS) raw bytes', bundle.raw);
    record('Shipped shell gzip bytes', bundle.gzip);
    record('Shipped shell brotli bytes', bundle.brotli);
    const js = bundle.files.find((f) => f.file.endsWith('.js'));
    if (js) {
      record('JavaScript bundle raw bytes', js.raw);
      record('JavaScript bundle gzip bytes', js.gzip);
      record('JavaScript bundle brotli bytes', js.brotli);
    }
  } else {
    record('dist/ not built', 'run npm run build to measure the bundle');
  }

  // ---- 5. Fallback ----------------------------------------------------------------------
  const fbPath = join(ROOT, 'docs', 'fallback-stats.json');
  if (existsSync(fbPath)) {
    const fb = JSON.parse(readFileSync(fbPath, 'utf8'));
    check('Fallback marks are inside the ceiling', fb.marksDrawn <= fb.markCeiling, true,
      fb.marksDrawn + ' of a ' + fb.markCeiling + ' ceiling');
    if (existsSync(join(DIST, 'index.html'))) {
      const html = readFileSync(join(DIST, 'index.html'), 'utf8');
      const circles = (html.match(/<circle /g) || []).length;
      check('The served HTML really contains the fallback marks', circles, fb.marksDrawn);
      check('The served HTML carries the Agent James attribution',
        html.includes('agentjames.vercel.app') && html.includes('linkedin.com/in/james-lorenz-santos'), true);
      check('The served HTML prints the decimation ratio', html.includes('decimation of 1 in'), true);
      check('The served HTML contains no unresolved fallback marker', html.includes('DIPMETER_FALLBACK'), false);
    }
  }

  // ---- 6. The README ---------------------------------------------------------------------
  // A README is a place where numbers go stale silently, so the headline figures in it are
  // checked against the generated manifest and the generated reports rather than trusted.
  const readmePath = join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const has = (n) => readme.includes(Number(n).toLocaleString('en-US'));
    const c = manifest.counts;
    const claims = [
      ['total events', c.events],
      ['CSV bytes', manifest.sources.comcat.csvBytes],
      ['CSV data rows', manifest.sources.comcat.dataRows],
      ['tier A events', c.tierA],
      ['tier B events', c.tierB],
      ['assigned-depth events', c.defaultDepth],
      ['shallow events', c.regimes.shallow],
      ['earthquake-type events', c.byType.earthquake],
      ['Natural Earth GeoJSON bytes', manifest.sources.naturalEarth.geojsonBytes],
      ['coastline strands', manifest.sources.naturalEarth.strands],
      ['coastline points', manifest.sources.naturalEarth.points],
      ['events-a.bin raw bytes', manifest.payload['events-a.bin'].raw],
      ['events-b.bin raw bytes', manifest.payload['events-b.bin'].raw],
      ['slabs.bin raw bytes', manifest.payload['slabs.bin'].raw],
      ['coast.bin raw bytes', manifest.payload['coast.bin'].raw],
    ];
    for (const [label, value] of claims) {
      check('README states the ' + label, has(value), true, String(value));
    }
    const fbPath2 = join(ROOT, 'docs', 'fallback-stats.json');
    if (existsSync(fbPath2)) {
      const fb = JSON.parse(readFileSync(fbPath2, 'utf8'));
      check('README states the fallback mark count', has(fb.marksDrawn), true, String(fb.marksDrawn));
      check('README states the decimation ratio', has(fb.decimationRatio), true, String(fb.decimationRatio));
    }
    const bundlePath = join(ROOT, 'docs', 'bundle-report.json');
    if (existsSync(bundlePath)) {
      const bp = JSON.parse(readFileSync(bundlePath, 'utf8'));
      if (bp.shell && bp.shell.javascript) {
        check('README states the JS gzip size', has(bp.shell.javascript.gzip), true, String(bp.shell.javascript.gzip));
        check('README states the JS raw size', has(bp.shell.javascript.raw), true, String(bp.shell.javascript.raw));
        check('README states the shell gzip total', has(bp.shell.total.gzip), true, String(bp.shell.total.gzip));
      }
      if (bp.reference && bp.reference.javascript) {
        check('README states the measured reference JS gzip', has(bp.reference.javascript.gzip), true,
          String(bp.reference.javascript.gzip));
      }
    }
    check('README makes no hazard or forecast claim',
      /\b(hazard map is|will occur|probability of|risk of an earthquake|forecast that)\b/i.test(readme), false);
  }

  // ---- Report ---------------------------------------------------------------------------
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const tag = r.informational ? '    ' : (r.ok ? 'PASS' : 'FAIL');
    let line = tag + '  ' + r.label.padEnd(width) + '  ' + fmt(r.actual);
    if (!r.ok) line += '   EXPECTED ' + fmt(r.expected);
    if (r.note) line += '   (' + r.note + ')';
    process.stdout.write(line + '\n');
  }
  process.stdout.write('\n' + (failures === 0
    ? 'All ' + results.filter((r) => !r.informational).length + ' checks passed.\n'
    : failures + ' CHECK(S) FAILED.\n'));
  if (failures > 0) process.exitCode = 1;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; }
}
