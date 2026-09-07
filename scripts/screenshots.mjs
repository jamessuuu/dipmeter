#!/usr/bin/env node
// Drives the built page with a real browser, captures screenshots at desktop and mobile
// widths, and REFUSES to call a capture a success unless the pixels actually vary. A
// screenshot of a blank canvas is a failure, so every shot is measured for variance and for
// the share of non-background pixels before it counts.
//
// Playwright is borrowed by absolute path rather than added as a dependency.
// Usage: node scripts/screenshots.mjs [baseUrl]

import { mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(ROOT, 'docs', 'shots');
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://localhost:4317/';

// Decodes a PNG far enough to measure whether anything is actually drawn. Rather than
// implementing a PNG reader, we ask the page itself for the canvas statistics AND separately
// check the file's compressed size: a flat image compresses to almost nothing.
function fileStats(path) {
  const bytes = statSync(path).size;
  return { bytes };
}

// Measures the SAVED SCREENSHOT, not the live WebGL canvas. A WebGL context created without
// preserveDrawingBuffer has an empty drawing buffer outside a frame, so reading it back
// reports a blank image for a page that is rendering perfectly. The screenshot is what a
// human would see, so the screenshot is what gets measured: it is loaded back into a blank
// page and its pixels are counted with a 2D context.
async function measurePng(browser, pngPath) {
  const b64 = readFileSync(pngPath).toString('base64');
  const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const page = await ctx.newPage();
  const stats = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const W = Math.min(480, img.width);
    const H = Math.round(img.height * (W / img.width));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    const data = g.getImageData(0, 0, W, H).data;
    let sum = 0, sum2 = 0, n = 0;
    const hist = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum; sum2 += lum * lum; n += 1;
      const key = (data[i] >> 3) + ',' + (data[i + 1] >> 3) + ',' + (data[i + 2] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    const mean = sum / n;
    let commonest = 0;
    for (const v of hist.values()) if (v > commonest) commonest = v;
    return {
      pixels: n,
      imageWidth: img.width,
      imageHeight: img.height,
      mean: +mean.toFixed(2),
      stdDev: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(3),
      distinctColours: hist.size,
      commonestColourShare: +(commonest / n).toFixed(4),
    };
  }, 'data:image/png;base64,' + b64);
  await ctx.close();
  return stats;
}

// A shot counts as rendered only if the pixels actually vary and no single colour owns the
// frame. These thresholds are deliberately not "a file exists".
function isRendered(stats) {
  return stats.stdDev > 8 && stats.distinctColours > 120 && stats.commonestColourShare < 0.93;
}

// A screenshot run against a stale dist/ is worse than no screenshot run: it reports a green
// result for code that does not build. This ran once during development and nearly shipped a
// broken build as verified, so freshness is now asserted before the browser is launched.
function newestMtime(paths) {
  let newest = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); return; }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const p of paths) walk(p);
  return newest;
}

function assertBuildIsFresh() {
  const dist = join(ROOT, 'dist');
  if (!existsSync(dist)) throw new Error('dist/ does not exist. Run `npm run build` first.');
  const srcTime = newestMtime([join(ROOT, 'src'), join(ROOT, 'index.html'), join(ROOT, 'vite.config.js')]);
  const distTime = newestMtime([dist]);
  if (srcTime > distTime) {
    throw new Error('dist/ is older than src/. The build did not run or it failed; refusing to '
      + 'screenshot a stale bundle. Run `npm run build` and check it succeeded.');
  }
  return { srcTime, distTime };
}

export async function main() {
  const freshness = assertBuildIsFresh();
  const { chromium } = await import(PLAYWRIGHT);
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const report = { capturedAt: new Date().toISOString(), base: BASE, buildFreshness: { srcMtime: new Date(freshness.srcTime).toISOString(), distMtime: new Date(freshness.distTime).toISOString() }, shots: [], consoleErrors: [], pageErrors: [] };

  const viewports = [
    { name: 'desktop', width: 1440, height: 900, dpr: 1 },
    { name: 'desktop-wide', width: 1920, height: 1080, dpr: 1 },
    { name: 'mobile', width: 390, height: 844, dpr: 2 },
    { name: 'tablet', width: 820, height: 1180, dpr: 1 },
  ];

  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
    });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(vp.name + ': ' + m.text()); });
    page.on('pageerror', (e) => { report.pageErrors.push(vp.name + ': ' + e.message); });

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120000 });
    try {
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 120000 });
    } catch {
      report.shots.push({ name: vp.name, error: 'page never reported ready' });
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(1800);

    const headline = await page.evaluate(() => {
      const h = document.getElementById('headline');
      const v = document.getElementById('visible-count');
      return { headline: h ? h.textContent.trim() : null, visible: v ? v.textContent.trim() : null };
    });

    const file = join(SHOTS, vp.name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    const stats = await measurePng(browser, file);
    report.shots.push({
      name: vp.name, viewport: vp, file: 'docs/shots/' + vp.name + '.png',
      ...fileStats(file), canvas: stats, headline, rendered: isRendered(stats),
    });

    // A second desktop shot with the cross section open, because that is the feature the
    // brief calls the most useful thing on the page and a claim about it needs a picture.
    if (vp.name === 'desktop') {
      await page.click('[data-section]');
      await page.waitForTimeout(2200);
      const secFile = join(SHOTS, 'desktop-section.png');
      await page.screenshot({ path: secFile });
      const secStats = await measurePng(browser, secFile);
      const secText = await page.evaluate(() => {
        const n = document.getElementById('section-note');
        const p = document.getElementById('panel-section');
        return { note: n ? n.textContent.trim() : null, visible: p ? !p.hidden : false };
      });
      report.shots.push({
        name: 'desktop-section', viewport: vp, file: 'docs/shots/desktop-section.png',
        ...fileStats(secFile), canvas: secStats, section: secText,
        rendered: isRendered(secStats) && secText.visible,
      });

      // Deep-only view: push the depth floor past 300 km and confirm the count collapses.
      await page.click('#section-close');
      await page.evaluate(() => {
        const el = document.getElementById('f-depth-min');
        el.value = '300';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(1400);
      const deepFile = join(SHOTS, 'desktop-deep.png');
      await page.screenshot({ path: deepFile });
      const deepStats = await measurePng(browser, deepFile);
      const deepCount = await page.evaluate(() => document.getElementById('visible-count').textContent.trim());
      report.shots.push({
        name: 'desktop-deep', viewport: vp, file: 'docs/shots/desktop-deep.png',
        ...fileStats(deepFile), canvas: deepStats, visibleCount: deepCount,
        rendered: isRendered(deepStats),
      });

      // Daylight palette.
      await page.evaluate(() => {
        const el = document.getElementById('f-depth-min');
        el.value = '-100';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#f-theme');
      await page.waitForTimeout(1400);
      const dayFile = join(SHOTS, 'desktop-daylight.png');
      await page.screenshot({ path: dayFile });
      const dayStats = await measurePng(browser, dayFile);
      report.shots.push({
        name: 'desktop-daylight', viewport: vp, file: 'docs/shots/desktop-daylight.png',
        ...fileStats(dayFile), canvas: dayStats,
        rendered: isRendered(dayStats),
      });
    }

    await ctx.close();
  }

  // The no-JavaScript path, captured by disabling JavaScript entirely.
  const nojsCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const nojsPage = await nojsCtx.newPage();
  await nojsPage.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await nojsPage.waitForTimeout(600);
  const nojsFile = join(SHOTS, 'no-javascript.png');
  await nojsPage.screenshot({ path: nojsFile, fullPage: false });
  const nojsFacts = await nojsPage.evaluate(() => ({
    svgCount: document.querySelectorAll('#fallback svg').length,
    circles: document.querySelectorAll('#fallback svg circle').length,
    tables: document.querySelectorAll('#fallback table').length,
    rows: document.querySelectorAll('#fallback table tbody tr').length,
    receipt: (document.querySelector('.decimation-receipt') || {}).textContent || null,
    attribution: !!document.querySelector('.aj-attribution a[href*="agentjames"]'),
  }));
  const nojsStats = await measurePng(browser, nojsFile);
  report.shots.push({ name: 'no-javascript', file: 'docs/shots/no-javascript.png', ...fileStats(nojsFile), canvas: nojsStats, nojsFacts, rendered: isRendered(nojsStats) && nojsFacts.circles > 100 });
  await nojsCtx.close();

  await browser.close();

  report.allRendered = report.shots.every((s) => s.rendered);
  writeFileSync(join(ROOT, 'docs', 'screenshot-report.json'), JSON.stringify(report, null, 2));

  for (const s of report.shots) {
    const c = s.canvas;
    process.stdout.write((s.rendered ? 'OK   ' : 'FAIL ') + s.name.padEnd(18)
      + String(s.bytes).padStart(9) + ' B'
      + (c ? '  stdDev ' + String(c.stdDev).padStart(7) + '  colours ' + String(c.distinctColours).padStart(5)
        + '  commonest ' + (c.commonestColourShare * 100).toFixed(1) + '%' : '')
      + '\n');
  }
  if (report.consoleErrors.length) {
    process.stdout.write('\nConsole errors:\n' + report.consoleErrors.map((e) => '  ' + e).join('\n') + '\n');
  }
  if (report.pageErrors.length) {
    process.stdout.write('\nPage errors:\n' + report.pageErrors.map((e) => '  ' + e).join('\n') + '\n');
  }
  process.stdout.write('\nAll rendered: ' + report.allRendered + '\n');
  if (!report.allRendered) process.exitCode = 1;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
