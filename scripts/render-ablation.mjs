#!/usr/bin/env node
// render-ablation.mjs — measure the rendering pipeline one variable at a time.
//
//   npx vite preview --port 4317 --strictPort   (or set DIPMETER_URL)
//   node scripts/render-ablation.mjs
//
// The question this answers is not "does it look nicer". It is: does the change make
// the DEPTH ENCODING more or less legible, because that encoding is the product.
// Three numbers per case:
//
//   gpuMs      EXT_disjoint_timer_query_webgl2 around the real render call. The run
//              FAILS rather than reports if a software rasteriser is in play.
//   agreement  How far the rendered hypocentres are from the legend swatch that claims
//              to explain them, in OKLab. ramp.js opens by promising these cannot drift.
//   separation Mean OKLab distance between the three depth bands as rendered. Higher is
//              a more legible depth encoding.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOCS = join(ROOT, 'docs');
const SHOTS = join(DOCS, 'ablation');
const BASE = process.env.DIPMETER_URL || 'http://localhost:4317';
const PLAYWRIGHT = 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
const VIEW = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = process.env.DIPMETER_CASES
  ? JSON.parse(readFileSync(process.env.DIPMETER_CASES, 'utf8'))
  : [
      ['00-before', 'output=0&tone=none', 'The pipeline as shipped before this change: the custom shaders wrote linear-sRGB values straight into an sRGB framebuffer, and there was no tone mapping anywhere.'],
      ['01-colorspace', 'output=1&tone=none', 'The output colour transform restored in the custom shaders. Nothing else.'],
      ['02-shipped', '', 'Shipped: colour transform + Khronos PBR Neutral tone mapping at exposure 1.0.'],
      ['03-agx', 'tone=agx', 'AgX instead of Neutral, to show why a data page cannot use it.'],
      ['04-aces', 'tone=aces', 'ACES Filmic, for completeness.'],
    ];

// Depth bands to probe, and the depth used for the legend comparison.
const BANDS = [[0, 30, 15], [280, 330, 305], [560, 660, 610]];

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearSrgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const oklabOf = (rgb255) => linearSrgbToOklab(...rgb255.map((v) => srgbToLinear(v / 255)));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function run() {
  const { chromium } = await import(PLAYWRIGHT);
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--hide-scrollbars', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  const out = { measuredAt: new Date().toISOString(), base: BASE, viewport: VIEW, cases: [] };

  for (const [id, query, note] of CASES) {
    const errors = [];
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    await page.goto(`${BASE}/?${query}`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 180000 });
    await sleep(2500);
    // Identical camera for every case, damping settled, so the frame being timed and
    // sampled is the same frame each time.
    await page.evaluate(() => {
      const d = window.__dipmeter;
      d.camera.position.set(1.42, 0.72, 1.98);
      d.camera.lookAt(0, 0, 0);
      d.camera.updateMatrixWorld();
      d.render();
    });
    await sleep(400);

    const gpu = await page.evaluate(() => {
      const gl = window.__dipmeter.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        devicePixelRatio: window.devicePixelRatio,
        pixelRatio: window.__dipmeter.renderer.getPixelRatio(),
      };
    });
    if (/swiftshader|software|llvmpipe|basic render/i.test(gpu.renderer)) {
      throw new Error(`software rasteriser (${gpu.renderer}) — GPU times would be fiction, refusing to report`);
    }
    out.gpu = gpu;

    // --- GPU time, from the GPU, around the real render call --------------------
    const gpuMs = await page.evaluate(async () => {
      const d = window.__dipmeter;
      const gl = d.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return { error: 'EXT_disjoint_timer_query_webgl2 unavailable' };
      const samples = [];
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 140; i++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        d.render();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        await frame();
        // Drain: give the query a few frames to become available.
        for (let k = 0; k < 6; k++) {
          if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          await frame();
        }
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        }
        gl.deleteQuery(q);
      }
      if (samples.length < 20) return { error: `only ${samples.length} usable samples` };
      samples.sort((a, b) => a - b);
      const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
      return {
        samples: samples.length,
        medianMs: Number(at(0.5).toFixed(4)),
        p95Ms: Number(at(0.95).toFixed(4)),
        method: 'EXT_disjoint_timer_query_webgl2 TIME_ELAPSED around renderer.render()',
      };
    });
    if (gpuMs.error) throw new Error(`GPU timing failed: ${gpuMs.error}`);

    await page.screenshot({ path: join(SHOTS, `${id}.png`), type: 'png' });

    // --- Legibility of the depth encoding, from the rendered pixels --------------
    const colour = await page.evaluate(async (BANDS) => {
      const d = window.__dipmeter;
      let pts = null;
      const others = [];
      d.scene.traverse((o) => {
        if (o.name === 'hypocentres') pts = o;
        else if (o.isMesh || o.isLine || o.isLineSegments) others.push(o);
      });
      const gl = d.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const prev = pts.material.uniforms.uDepthRange.value.slice();
      // Everything that is not a hypocentre is hidden for the measurement. The slabs are
      // depth-coloured too and cover far more pixels than the points do, so leaving them
      // on measures the slabs and calls it the data.
      const wasVisible = others.map((o) => o.visible);
      for (const o of others) o.visible = false;

      const prevMag = pts.material.uniforms.uMagMin.value;
      const measureBand = async (lo, hi, magMin) => {
        pts.material.uniforms.uDepthRange.value = [lo, hi];
        pts.material.uniforms.uMagMin.value = magMin;
        d.render();
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        // The points are the most chromatic pixels in the frame. Take the top decile by
        // chroma so the measurement is of the data, not of the shell or the background.
        const rows = [];
        let clipped = 0;
        let dataPixels = 0;
        for (let i = 0; i < w * h; i++) {
          const o = i * 4;
          const r = buf[o], g = buf[o + 1], b = buf[o + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx < 24) continue;
          dataPixels++;
          // Clipping is counted over EVERY data pixel, not over a top slice: a slice
          // shrinks as the image darkens, which would make a darker pipeline look like
          // it clips more when it clips less.
          if (r >= 254 || g >= 254 || b >= 254) clipped++;
          rows.push([mx - mn, r, g, b]);
        }
        rows.sort((a, z) => z[0] - a[0]);
        const take = Math.max(1, Math.floor(rows.length * 0.1));
        let R = 0, G = 0, B = 0;
        for (let i = 0; i < take; i++) { R += rows[i][1]; G += rows[i][2]; B += rows[i][3]; }
        return {
          rgb: [R / take, G / take, B / take],
          pixels: dataPixels,
          clippedFraction: Number((clipped / Math.max(1, dataPixels)).toFixed(5)),
        };
      };

      const bands = [];
      const sparse = [];
      for (const [lo, hi, mid] of BANDS) {
        // Dense: every event in the band, so pile-ups dominate — this is what the busy
        // parts of the globe actually look like.
        bands.push({ lo, hi, mid, ...(await measureBand(lo, hi, 4.5)) });
        // Sparse: M6.5 and above only, so the sampled points are mostly ISOLATED and a
        // single splat's colour is being read rather than a stack of them. This is the
        // case where a reader looks up one event against the legend.
        sparse.push({ lo, hi, mid, ...(await measureBand(lo, hi, 6.5)) });
      }
      pts.material.uniforms.uDepthRange.value = prev;
      pts.material.uniforms.uMagMin.value = prevMag;
      others.forEach((o, i) => { o.visible = wasVisible[i]; });
      d.render();

      // What the legend swatch claims each of those depths is, from the page's own
      // CPU-side ramp — the twin that ramp.js promises cannot drift from the globe.
      const legend = BANDS.map(([, , mid]) => d.depthColorHex(mid));
      return { bands, sparse, legend };
    }, BANDS);

    const lab = colour.bands.map((b) => oklabOf(b.rgb));
    const labSparse = colour.sparse.map((b) => oklabOf(b.rgb));
    const separation = Number(((dist(lab[0], lab[1]) + dist(lab[1], lab[2]) + dist(lab[0], lab[2])) / 3).toFixed(4));

    // Hue agreement between the rendered hypocentres and the legend that explains them.
    // Hue rather than full colour because the points are alpha-blended over the shell, so
    // their lightness legitimately differs from a solid swatch; their HUE must not.
    const hueOf = (lb) => (Math.atan2(lb[2], lb[1]) * 180) / Math.PI;
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const agreement = colour.bands.map((b, i) => {
      const want = hueOf(oklabOf(hex(colour.legend[i])));
      const got = hueOf(lab[i]);
      let dh = Math.abs(want - got) % 360;
      if (dh > 180) dh = 360 - dh;
      return { band: `${b.lo}-${b.hi} km`, legend: colour.legend[i], renderedRgb: b.rgb.map((v) => Math.round(v)), hueErrorDeg: Number(dh.toFixed(2)) };
    });
    const meanHueError = Number((agreement.reduce((a, x) => a + x.hueErrorDeg, 0) / agreement.length).toFixed(2));

    // The measurement that decides this: how close an ISOLATED hypocentre is to the
    // legend swatch that claims to explain it, as a full OKLab distance rather than hue
    // alone. A single splat is not a pile-up, so lightness is meaningful here.
    const sparseAgreement = colour.sparse.map((b, i) => {
      const want = oklabOf(hex(colour.legend[i]));
      return {
        band: `${b.lo}-${b.hi} km`,
        legend: colour.legend[i],
        renderedRgb: b.rgb.map((v) => Math.round(v)),
        oklabDistance: Number(dist(want, labSparse[i]).toFixed(4)),
      };
    });
    const meanSparseDistance = Number(
      (sparseAgreement.reduce((a, x) => a + x.oklabDistance, 0) / sparseAgreement.length).toFixed(4));
    const clipped = Number((colour.bands.reduce((a, b) => a + b.clippedFraction, 0) / colour.bands.length).toFixed(4));

    out.cases.push({
      id, query, note, gpuMs, gpu,
      legendAgreement: agreement,
      meanHueErrorDeg: meanHueError,
      isolatedPointVsLegend: sparseAgreement,
      meanIsolatedOklabDistance: meanSparseDistance,
      clippedFractionOfDataPixels: clipped,
      oklabSeparation: separation,
      errors,
      shot: `docs/ablation/${id}.png`,
    });
    console.log(
      `${id.padEnd(14)} gpu ${String(gpuMs.medianMs).padStart(7)} ms  ` +
        `separation ${separation}  isolated-vs-legend OKLab ${meanSparseDistance}  clipped ${clipped}`,
    );
    for (const a of agreement) {
      console.log(`   ${a.band.padEnd(12)} rendered rgb(${a.renderedRgb.join(',')})  legend ${a.legend}  hue error ${a.hueErrorDeg} deg`);
    }
    if (errors.length) console.log(`   console errors: ${errors.join(' | ')}`);
  }

  await browser.close();
  writeFileSync(join(DOCS, 'render-ablation.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote docs/render-ablation.json');
}

run().catch((e) => { console.error(e); process.exit(1); });
