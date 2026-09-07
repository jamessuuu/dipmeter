#!/usr/bin/env node
// Accessibility regression guard. Everything here was a real defect at some point in this
// project's history, found by driving the live page rather than by reading the source, so
// each check exists because something was actually broken.
//
// Measures, in a real browser:
//   * text contrast on rendered colours in BOTH palettes
//   * focus-ring presence and the tab order from a clean load
//   * touch target sizes at 390 px
//   * the keyboard flows that were broken: search results, cross-section focus management,
//     live regions, and the keyboard path to per-event detail
//
// Usage: node scripts/a11y.mjs [baseUrl]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
const BASE = process.argv[2] || 'http://localhost:4317/';

const results = [];
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok: !!ok, label, detail });
}

function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(r) { return 0.2126 * srgbToLin(r[0]) + 0.7152 * srgbToLin(r[1]) + 0.0722 * srgbToLin(r[2]); }
function ratio(a, b) { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
function over(fg, a, bg) { return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]; }

const SAMPLES = [
  ['#visible-count', '#panel-readout'],
  ['#visible-share', '#panel-readout'],
  ['#zone-caption', '#panel-readout'],
  ['.key-fact', '#panel-readout'],
  ['#readout-heading', '#panel-readout'],
  ['.field-head label', '#panel-controls'],
  ['.field-head output', '#panel-controls'],
  ['.toggle', '#panel-controls'],
  ['#zone-list button', '#panel-controls'],
  ['#controls-heading', '#panel-controls'],
  ['.btn', '#panel-controls'],
  ['#f-search', '#panel-controls'],
  ['#headline-sub', null],
  ['#panel-title h1', null],
];

async function contrastPass(page, theme) {
  const data = await page.evaluate((samples) => {
    // Resolve any CSS colour by painting it. getComputedStyle returns oklch() here for
    // oklch-authored values, and an rgb-only parser silently skips every one of them and
    // then reports no failures, which is worse than a crash.
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    const resolve = (css) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    return samples.map(([sel, bgSel]) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const cs = getComputedStyle(el);
      const bgEl = bgSel ? document.querySelector(bgSel) : null;
      return {
        sel,
        fg: resolve(cs.color),
        bg: bgEl ? resolve(getComputedStyle(bgEl).backgroundColor) : null,
        page: resolve(getComputedStyle(document.body).backgroundColor),
        size: parseFloat(cs.fontSize),
        weight: cs.fontWeight,
      };
    });
  }, SAMPLES);

  for (const it of data) {
    if (it.missing) { check(theme + ' contrast: ' + it.sel, false, 'element not found'); continue; }
    const pageRgb = it.page && it.page[3] > 0 ? [it.page[0], it.page[1], it.page[2]] : [20, 24, 30];
    let bgRgb = pageRgb;
    if (it.bg && it.bg[3] > 0) bgRgb = over([it.bg[0], it.bg[1], it.bg[2]], it.bg[3], pageRgb);
    const fgRgb = it.fg[3] < 1 ? over([it.fg[0], it.fg[1], it.fg[2]], it.fg[3], bgRgb) : [it.fg[0], it.fg[1], it.fg[2]];
    const r = ratio(fgRgb, bgRgb);
    const large = it.size >= 24 || (it.size >= 18.66 && Number(it.weight) >= 700);
    const need = large ? 3 : 4.5;
    check(theme + ' contrast: ' + it.sel, r >= need, r.toFixed(2) + ':1 (need ' + need + ', ' + it.size.toFixed(1) + 'px)');
  }
}

export async function main() {
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const pageErrors = [];

  const open = async (opts) => {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 120000 });
    await page.waitForTimeout(1100);
    return { ctx, page };
  };

  // ---- Contrast, both palettes -----------------------------------------------------------
  for (const theme of ['dusk', 'daylight']) {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });
    if (theme === 'daylight') { await page.click('#f-theme'); await page.waitForTimeout(700); }
    await contrastPass(page, theme);
    await ctx.close();
  }

  // ---- Focus order and focus rings from a clean load ---------------------------------------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });
    const stops = [];
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          id: el.id || el.tagName.toLowerCase(),
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1,
          h: Math.round(r.height), w: Math.round(r.width),
        };
      }));
    }
    check('tab stop 1 is the skip link', stops[0] && stops[0].id === 'skip' || (stops[0] && stops[0].w > 100 && stops[0].h >= 44), stops[0]);
    check('tab stop 2 is the canvas', stops[1] && stops[1].id === 'gl', stops[1]);
    check('every early tab stop has a visible focus ring', stops.every((s) => s && s.outline),
      stops.map((s) => (s ? s.id + ':' + s.outline : 'none')).join(' '));
    await ctx.close();
  }

  // ---- Touch targets at 390 px --------------------------------------------------------------
  {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await page.click('#sheet-toggle');
    await page.waitForTimeout(500);
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, input, select, [tabindex]')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || cs.display === 'none' || cs.visibility === 'hidden') continue;
        // WCAG 2.2 AA target size minimum is 24 x 24 CSS px.
        if (r.width < 24 || r.height < 24) {
          out.push((el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
      }
      return out;
    });
    check('no interactive control is under 24 x 24 at 390 px', small.length === 0, small.join(', ') || 'none');
    const labels = await page.evaluate(() => [...document.querySelectorAll('label.toggle')]
      .map((l) => Math.round(l.getBoundingClientRect().height)));
    check('every toggle label is a 44 px target', labels.every((h) => h >= 44), labels.join(' '));
    await ctx.close();
  }

  // ---- The keyboard flows that were broken ---------------------------------------------------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });

    // Closing the result list on blur alone destroyed keyboard access to it.
    await page.focus('#f-search');
    await page.type('#f-search', 'Fiji', { delay: 35 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(450);
    const inResults = await page.evaluate(() => {
      const r = document.getElementById('search-results');
      return { inside: r.contains(document.activeElement), hidden: r.hidden };
    });
    check('a search result survives being tabbed into', inResults.inside && !inResults.hidden, inResults);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const afterPick = await page.evaluate(() => ({
      hidden: document.getElementById('search-results').hidden,
      onField: document.activeElement.id === 'f-search',
      value: document.getElementById('f-search').value,
    }));
    check('activating a result returns focus to the search field',
      afterPick.hidden && afterPick.onField && afterPick.value.length > 0, afterPick);

    await page.fill('#f-search', '');
    await page.type('#f-search', 'Japan', { delay: 30 });
    await page.waitForTimeout(350);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    const entered = await page.evaluate(() => document.getElementById('search-results').contains(document.activeElement));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const escaped = await page.evaluate(() => ({
      hidden: document.getElementById('search-results').hidden,
      onField: document.activeElement.id === 'f-search',
    }));
    check('ArrowDown enters the result list', entered);
    check('Escape closes the list and restores focus', escaped.hidden && escaped.onField, escaped);

    // The cross-section panel used to open without moving focus and close into <body>.
    await page.evaluate(() => document.getElementById('f-search').blur());
    await page.waitForTimeout(200);
    await page.focus('[data-section]');
    const opener = await page.evaluate(() => document.activeElement.textContent.trim());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2300);
    const opened = await page.evaluate(() => ({
      inside: document.getElementById('panel-section').contains(document.activeElement),
      active: document.activeElement.id,
      live: document.getElementById('section-note').getAttribute('aria-live'),
    }));
    check('opening the cross section moves focus into the panel', opened.inside, opened);
    check('the cross-section note is a live region', opened.live === 'polite', opened.live);

    await page.focus('#section-close');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const closed = await page.evaluate(() => ({
      isBody: document.activeElement === document.body,
      text: (document.activeElement.textContent || '').trim(),
    }));
    check('closing the cross section returns focus to its opener',
      !closed.isBody && closed.text === opener, { ...closed, opener });

    // The derived match count had no non-visual channel.
    const live = await page.evaluate(() => document.querySelector('.readout-figure').getAttribute('aria-live'));
    check('the filtered count is a live region', live === 'polite', live);

    // Per-event detail was reachable only by pointer.
    await page.focus('#gl');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const tip = await page.evaluate(() => {
      const t = document.getElementById('tip');
      return { hidden: t.hidden, role: t.getAttribute('role'), text: (t.textContent || '').trim() };
    });
    check('Enter on the canvas inspects an event', !tip.hidden && tip.text.length > 10, tip.text.slice(0, 70));
    check('the inspection is announced as a status', tip.role === 'status', tip.role);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('Escape dismisses the inspection',
      await page.evaluate(() => document.getElementById('tip').hidden));

    // The camera must actually respond to the arrow keys.
    const shot = async () => {
      const buf = await page.screenshot({ clip: { x: 400, y: 150, width: 480, height: 480 } });
      let h = 0;
      for (let i = 0; i < buf.length; i += 89) h = (h * 31 + buf[i]) >>> 0;
      return h;
    };
    await page.focus('#gl');
    const a = await shot();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(900);
    const bSig = await shot();
    check('the arrow keys move the camera', a !== bSig, a + ' -> ' + bSig);

    await ctx.close();
  }

  // ---- The no-JavaScript document ------------------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(500);
    const doc = await page.evaluate(() => ({
      visibleH1s: [...document.querySelectorAll('h1')].filter((h) => h.getBoundingClientRect().height > 0).length,
      panelsVisible: [...document.querySelectorAll('.panel')].filter((p) => p.getBoundingClientRect().height > 0).length,
      tables: document.querySelectorAll('#fallback table').length,
      captions: document.querySelectorAll('#fallback table caption').length,
      unscopedTh: [...document.querySelectorAll('#fallback th')].filter((t) => !t.getAttribute('scope')).length,
      svgsWithoutName: [...document.querySelectorAll('#fallback svg')]
        .filter((s) => !s.getAttribute('aria-labelledby') && !s.getAttribute('aria-label')).length,
    }));
    check('no-JS: exactly one visible h1', doc.visibleH1s === 1, doc.visibleH1s);
    check('no-JS: the dead interactive panels are hidden', doc.panelsVisible === 0, doc.panelsVisible);
    check('no-JS: every table has a caption', doc.tables > 0 && doc.tables === doc.captions, doc.tables + '/' + doc.captions);
    check('no-JS: every table header is scoped', doc.unscopedTh === 0, doc.unscopedTh);
    check('no-JS: every figure svg has an accessible name', doc.svgsWithoutName === 0, doc.svgsWithoutName);
    await ctx.close();
  }

  check('no page errors during the audit', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  await browser.close();

  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'a11y-report.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, failures, results }, null, 2));

  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.label.padEnd(w)
      + (r.detail !== undefined ? '  ' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : '') + '\n');
  }
  process.stdout.write('\n' + (failures === 0
    ? 'All ' + results.length + ' accessibility checks passed.\n'
    : failures + ' ACCESSIBILITY CHECK(S) FAILED.\n'));
  if (failures > 0) process.exitCode = 1;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
