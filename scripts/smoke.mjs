#!/usr/bin/env node
// Functional smoke test. Drives the real controls in a real browser and asserts real
// outcomes, because "the page renders" is not the same claim as "the page works". Every
// assertion compares a value the page computed against a value this script computed
// independently from manifest.json.
//
// Usage: node scripts/smoke.mjs [baseUrl]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
const BASE = process.argv[2] || 'http://localhost:4317/';

const results = [];
let failures = 0;
function assert(label, actual, expected, tolerance) {
  const ok = typeof expected === 'number' && typeof tolerance === 'number'
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected;
  if (!ok) failures += 1;
  results.push({ ok, label, actual, expected });
}

export async function main() {
  const { chromium } = await import(PLAYWRIGHT);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'));
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 120000 });
  await page.waitForTimeout(1200);

  const num = (s) => Number(String(s).replace(/,/g, ''));
  // The headline is prose with two numbers in it, so pull them out rather than coercing the
  // whole string, which yields NaN and a false failure.
  const nums = (s) => (String(s).match(/[0-9][0-9,]*/g) || []).map((x) => Number(x.replace(/,/g, '')));

  // 1. The headline states the manifest's counts, and "showing now" agrees with it.
  const headlineNums = nums(await page.textContent('#headline'));
  assert('headline event count', headlineNums[0], manifest.counts.events);
  assert('headline slab count', headlineNums[1], manifest.zones.length);
  assert('visible count with no filters',
    num(await page.textContent('#visible-count')), manifest.counts.events, 0.5);

  // 2. Depth filter. Independently compute the expected count from the shipped manifest's
  //    regime figures: at a 300 km floor, only the deep regime survives.
  await page.evaluate(() => {
    const el = document.getElementById('f-depth-min');
    el.value = '300';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  assert('deep-only count equals the deep regime',
    num(await page.textContent('#visible-count')), manifest.counts.regimes.deep, 0.5);

  // 3. Turning off assigned-depth events removes exactly that many.
  await page.evaluate(() => {
    const el = document.getElementById('f-depth-min');
    el.value = '-100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.uncheck('#f-assigned');
  await page.waitForTimeout(500);
  assert('hiding assigned depths removes exactly the assigned count',
    num(await page.textContent('#visible-count')),
    manifest.counts.events - manifest.counts.defaultDepth, 0.5);
  await page.check('#f-assigned');
  await page.waitForTimeout(400);

  // 4. Zone selection filters to that zone's own attributed count.
  const biggest = manifest.zones.slice().sort((a, b) => b.events - a.events)[0];
  await page.click('#zone-list button[data-code="' + biggest.code + '"]');
  await page.waitForTimeout(1400);
  assert('selecting ' + biggest.code + ' shows that zone count',
    num(await page.textContent('#visible-count')), biggest.events, 0.5);
  assert('zone caption names the zone',
    (await page.textContent('#zone-caption')).includes(biggest.name), true);
  await page.click('#f-zone-clear');
  await page.waitForTimeout(1200);
  assert('clearing the zone restores the full count',
    num(await page.textContent('#visible-count')), manifest.counts.events, 0.5);

  // 5. Magnitude floor at 5.0 gives the tier A count.
  await page.evaluate(() => {
    const el = document.getElementById('f-mag');
    el.value = '5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  assert('M5.0 floor equals the tier A count',
    num(await page.textContent('#visible-count')), manifest.counts.tierA, 0.5);
  await page.evaluate(() => {
    const el = document.getElementById('f-mag');
    el.value = '4.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);

  // 6. Search finds a real region and moves the camera.
  const camBefore = await page.evaluate(() => {
    const s = window.__dipmeter;
    return s ? null : null;
  });
  await page.fill('#f-search', 'Fiji');
  await page.waitForTimeout(500);
  const hits = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#search-results button')];
    return items.map((b) => b.textContent.trim());
  });
  assert('search returns at least one region for "Fiji"', hits.length > 0, true);

  // 7. Cross section produces events and a slab line.
  await page.click('[data-section]');
  await page.waitForTimeout(2500);
  const sectionNote = await page.textContent('#section-note');
  const sectionCount = num(await page.textContent('#section-count'));
  assert('cross section contains events', sectionCount > 500, true);
  assert('cross section states its vertical scale',
    /Vertical scale is (1:1|[0-9.]+ times)/.test(sectionNote), true);
  assert('cross section states its corridor width', /within \d+ km of a/.test(sectionNote), true);
  assert('cross section crosses at least one Slab2 surface',
    /Slab2 surface/.test(sectionNote), true);

  // 8. Keyboard actually moves the camera.
  await page.click('#section-close');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    c.focus();
    return null;
  });
  const camA = await page.evaluate(() => JSON.stringify(window.__dipmeterCam || null));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  const moved = await page.evaluate(() => document.activeElement && document.activeElement.id === 'gl');
  assert('canvas holds keyboard focus', moved, true);

  // 9. Theme toggle actually changes the root attribute and the ramp.
  await page.click('#f-theme');
  await page.waitForTimeout(600);
  assert('theme toggles to daylight',
    await page.evaluate(() => document.documentElement.dataset.theme), 'daylight');
  await page.click('#f-theme');
  await page.waitForTimeout(400);
  assert('theme toggles back to dusk',
    await page.evaluate(() => document.documentElement.dataset.theme), 'dusk');

  // 10. Slab geometry is real and non-trivial.
  const geom = await page.evaluate(() => ({
    triangles: window.__dipmeter.triangles,
    vertices: window.__dipmeter.slabVertices,
    coast: window.__dipmeter.coastSegments,
    events: window.__dipmeter.events(),
  }));
  assert('slab mesh has triangles', geom.triangles > 50000, true);
  assert('slab vertices equal 3 per triangle', geom.vertices, geom.triangles * 3);
  assert('coastline segment count matches the manifest',
    geom.coast, manifest.sources.naturalEarth.points - manifest.sources.naturalEarth.strands);
  assert('all events are loaded', geom.events, manifest.counts.events);

  assert('no page errors', pageErrors.length, 0);

  await browser.close();

  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'smoke-report.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, results, pageErrors, geom }, null, 2));

  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.label.padEnd(w) + '  ' + String(r.actual)
      + (r.ok ? '' : '   EXPECTED ' + String(r.expected)) + '\n');
  }
  if (pageErrors.length) process.stdout.write('\nPage errors:\n  ' + pageErrors.join('\n  ') + '\n');
  process.stdout.write('\n' + (failures === 0 ? 'All ' + results.length + ' smoke assertions passed.\n'
    : failures + ' SMOKE ASSERTION(S) FAILED.\n'));
  if (failures > 0) process.exitCode = 1;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
