#!/usr/bin/env node
// Generates the served, no-JavaScript, no-WebGL twin of the page: a decimated SVG whose
// decimation ratio is printed inside it, plus the complete facet tables and the full search
// index as real HTML. Written to src/fallback.generated.html and injected into index.html by
// the Vite plugin in vite.config.js, so it is in the served markup rather than injected at
// runtime. Re-run with `npm run build:fallback`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCatalogue, DEFAULT_DEPTHS } from './lib/comcat.mjs';
import { listZones, readGrid, sampleGrid, ZONE_NAMES } from './lib/slab2.mjs';
import { oklchToHex } from './lib/oklch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = join(ROOT, 'data', 'raw');

// LIVENESS-STANDARD fixes the SVG mark ceiling at roughly 2,000 to 2,400. dipmeter has
// 230,059 marks to draw, so an SVG twin at full fidelity is out by two orders of magnitude.
// The decimation is therefore declared, printed, and held under the ceiling by construction.
const MARK_CEILING = 2400;
const CELL_LON = 2, CELL_LAT = 2, CELL_DEPTH = 50;

const STOPS = [
  { km: 0, lch: [0.72, 0.19, 32] },
  { km: 70, lch: [0.80, 0.16, 78] },
  { km: 300, lch: [0.68, 0.16, 305] },
  { km: 700, lch: [0.76, 0.13, 218] },
];

function depthHex(km) {
  let i = 0;
  while (i < STOPS.length - 2 && km > STOPS[i + 1].km) i += 1;
  const a = STOPS[i], b = STOPS[i + 1];
  const t = Math.max(0, Math.min(1, (km - a.km) / (b.km - a.km)));
  return oklchToHex(
    a.lch[0] + (b.lch[0] - a.lch[0]) * t,
    a.lch[1] + (b.lch[1] - a.lch[1]) * t,
    a.lch[2] + (b.lch[2] - a.lch[2]) * t
  );
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

// The same three corridors the risk probe measured, redrawn here as real depth sections so
// the no-JavaScript reader sees the actual claim of the page and not just a table about it.
const SECTIONS = [
  { key: 'tonga', label: 'Tonga', lat0: -20.0, lon0: 186.5, azimuth: 10, halfLengthKm: 180, halfWidthKm: 600, dipSign: -1 },
  { key: 'tohoku', label: 'Northern Japan', lat0: 39.5, lon0: 144.0, azimuth: 15, halfLengthKm: 200, halfWidthKm: 600, dipSign: -1 },
  { key: 'nchile', label: 'Northern Chile', lat0: -21.5, lon0: -70.9, azimuth: 0, halfLengthKm: 200, halfWidthKm: 700, dipSign: 1 },
];
const KM_PER_DEG = 111.32;

export function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'));
  const { events } = readCatalogue(join(RAW, 'comcat-m45-1990-2026.csv'));
  const kept = events.filter((e) => e.mag >= 4.5);

  // ---- Decimation: one mark per occupied 2 x 2 degree x 50 km cell --------------------
  const cells = new Map();
  for (const e of kept) {
    const ix = Math.floor((e.lon + 180) / CELL_LON);
    const iy = Math.floor((e.lat + 90) / CELL_LAT);
    const iz = Math.floor(Math.max(0, e.depth) / CELL_DEPTH);
    const key = ix + ':' + iy + ':' + iz;
    let cell = cells.get(key);
    if (!cell) { cell = { ix, iy, iz, n: 0, maxDepth: -Infinity }; cells.set(key, cell); }
    cell.n += 1;
    if (e.depth > cell.maxDepth) cell.maxDepth = e.depth;
  }
  const occupiedCells = cells.size;

  // Collapse to one mark per surface cell, coloured by the deepest event beneath it. That
  // keeps the geographic mark count inside the budget while the depth information survives.
  const surface = new Map();
  for (const c of cells.values()) {
    const key = c.ix + ':' + c.iy;
    let s = surface.get(key);
    if (!s) { s = { ix: c.ix, iy: c.iy, n: 0, maxDepth: -Infinity, layers: 0 }; surface.set(key, s); }
    s.n += c.n;
    s.layers += 1;
    if (c.maxDepth > s.maxDepth) s.maxDepth = c.maxDepth;
  }
  let surfaceCells = [...surface.values()].sort((a, b) => b.maxDepth - a.maxDepth || b.n - a.n);
  const mapBudget = 1500;
  const mapDrawn = Math.min(mapBudget, surfaceCells.length);
  const mapCells = surfaceCells.slice(0, mapDrawn);

  // ---- Cross sections ------------------------------------------------------------------
  const sectionBudget = Math.floor((MARK_CEILING - mapDrawn) / SECTIONS.length);
  const sections = SECTIONS.map((s) => {
    const az = s.azimuth * Math.PI / 180;
    const cosLat = Math.cos(s.lat0 * Math.PI / 180);
    const pts = [];
    for (const e of kept) {
      let dLon = e.lon - s.lon0;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      const eastKm = dLon * KM_PER_DEG * cosLat;
      const northKm = (e.lat - s.lat0) * KM_PER_DEG;
      const along = northKm * Math.cos(az) + eastKm * Math.sin(az);
      const across = -northKm * Math.sin(az) + eastKm * Math.cos(az);
      if (Math.abs(along) > s.halfLengthKm || Math.abs(across) > s.halfWidthKm) continue;
      pts.push({ x: s.dipSign * across, y: e.depth, assigned: DEFAULT_DEPTHS.some((d) => Math.abs(e.depth - d) < 1e-9) });
    }
    // Evenly stride the corridor rather than taking a head slice, so the drawn subset is a
    // sample of the whole section and not of one end of it.
    const stride = Math.max(1, Math.ceil(pts.length / sectionBudget));
    const drawn = pts.filter((_, i) => i % stride === 0).slice(0, sectionBudget);
    return { ...s, total: pts.length, drawn, stride };
  });

  const totalMarks = mapDrawn + sections.reduce((a, s) => a + s.drawn.length, 0);
  if (totalMarks > MARK_CEILING) {
    throw new Error('Fallback would draw ' + totalMarks + ' marks, over the ' + MARK_CEILING + ' ceiling.');
  }

  // ---- SVG: world map --------------------------------------------------------------
  const MW = 960, MH = 480;
  const mapMarks = mapCells.map((c) => {
    const lon = -180 + (c.ix + 0.5) * CELL_LON;
    const lat = -90 + (c.iy + 0.5) * CELL_LAT;
    const x = ((lon + 180) / 360) * MW;
    const y = ((90 - lat) / 180) * MH;
    const r = c.maxDepth >= 300 ? 2.6 : c.maxDepth >= 70 ? 2.1 : 1.7;
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r
      + '" fill="' + depthHex(Math.max(0, c.maxDepth)) + '" fill-opacity="0.85"/>';
  }).join('');

  const graticule = (() => {
    const out = [];
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * MW;
      out.push('<line x1="' + x.toFixed(1) + '" y1="0" x2="' + x.toFixed(1) + '" y2="' + MH + '"/>');
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * MH;
      out.push('<line x1="0" y1="' + y.toFixed(1) + '" x2="' + MW + '" y2="' + y.toFixed(1) + '"/>');
    }
    return '<g stroke="currentColor" stroke-opacity="0.14" stroke-width="1">' + out.join('') + '</g>';
  })();

  const mapSvg =
    '<svg viewBox="0 0 ' + MW + ' ' + MH + '" role="img" aria-labelledby="fb-map-title fb-map-desc" width="' + MW + '" height="' + MH + '">'
    + '<title id="fb-map-title">Deepest recorded earthquake in each occupied 2 by 2 degree cell</title>'
    + '<desc id="fb-map-desc">An equirectangular world map. Each mark is one 2 by 2 degree cell that contains at least one catalogued earthquake, coloured by the deepest event in it. Cool colours trace the subduction zones, because only a subducting slab carries earthquakes below 300 kilometres.</desc>'
    + graticule + mapMarks + '</svg>';

  // ---- SVG: cross sections -----------------------------------------------------------
  const sectionSvgs = sections.map((s) => {
    const W = 460, H = 220, padL = 42, padB = 26, padT = 12, padR = 10;
    const w = W - padL - padR, h = H - padT - padB;
    const maxX = s.halfWidthKm, maxD = 700;
    const X = (km) => padL + ((km + (s.dipSign > 0 ? maxX : maxX)) / (2 * maxX)) * w;
    const Y = (d) => padT + (Math.max(0, d) / maxD) * h;
    const axes = [];
    for (let d = 0; d <= maxD; d += 200) {
      axes.push('<line x1="' + padL + '" y1="' + Y(d).toFixed(1) + '" x2="' + (padL + w) + '" y2="' + Y(d).toFixed(1) + '"/>');
    }
    const labels = [];
    for (let d = 0; d <= maxD; d += 200) {
      labels.push('<text x="' + (padL - 6) + '" y="' + (Y(d) + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.6">' + d + '</text>');
    }
    const dots = s.drawn.map((p) => '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1)
      + '" r="1.5" fill="' + (p.assigned ? '#8a8a92' : depthHex(Math.max(0, p.y))) + '" fill-opacity="' + (p.assigned ? '0.35' : '0.9') + '"/>').join('');
    return {
      label: s.label,
      total: s.total,
      drawn: s.drawn.length,
      stride: s.stride,
      svg: '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="fb-' + s.key + '-t fb-' + s.key + '-d" width="' + W + '" height="' + H + '">'
        + '<title id="fb-' + s.key + '-t">Depth section across ' + esc(s.label) + '</title>'
        + '<desc id="fb-' + s.key + '-d">A vertical slice through the Earth across the ' + esc(s.label)
        + ' trench. The horizontal axis is distance across strike in kilometres and the vertical axis is depth to 700 kilometres. '
        + fmt(s.drawn.length) + ' of ' + fmt(s.total)
        + ' events in this corridor are drawn. The points form a plane sloping down and away from the trench, which is the Wadati-Benioff zone.</desc>'
        + '<g stroke="currentColor" stroke-opacity="0.16" stroke-width="1">' + axes.join('') + '</g>'
        + labels.join('') + dots
        + '<text x="' + padL + '" y="' + (H - 8) + '" font-size="10" fill="currentColor" fill-opacity="0.6">across strike, km. depth, km on the left axis.</text>'
        + '</svg>',
    };
  });

  // ---- Tables -------------------------------------------------------------------------
  const c = manifest.counts;
  const zoneRows = manifest.zones.slice().sort((a, b) => b.events - a.events).map((z) =>
    '<tr><td>' + esc(z.name) + '</td><td><code>' + z.code + '</code></td>'
    + '<td class="num">' + fmt(z.events) + '</td><td class="num">' + fmt(z.deepEvents) + '</td>'
    + '<td class="num">' + (z.depthMinKm === null ? 'n/a' : z.depthMinKm.toFixed(0) + ' to ' + z.depthMaxKm.toFixed(0)) + '</td>'
    + '<td>' + (z.overturns ? 'overturns past vertical' : '') + '</td></tr>').join('');

  const regionRows = manifest.regions.slice().sort((a, b) => b.count - a.count).map((r) =>
    '<tr><td>' + esc(r.name) + '</td><td class="num">' + fmt(r.count) + '</td>'
    + '<td class="num">' + r.lat.toFixed(1) + ', ' + r.lon.toFixed(1) + '</td></tr>').join('');

  const typeRows = Object.entries(c.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    '<tr><td>' + esc(k) + '</td><td class="num">' + fmt(v) + '</td></tr>').join('');

  const decimationRatio = (c.events / totalMarks).toFixed(0);
  // The depth split of slab attribution: the single most load-bearing ratio on the page, so
  // it is computed from the manifest here rather than written down anywhere.
  const deepTotal = c.regimes.intermediate + c.regimes.deep;
  const deepAttributed = manifest.zones.reduce((a, z) => a + z.deepEvents, 0);
  const zeroDeep = manifest.zones.filter((z) => z.deepEvents === 0);

  const html = `<header class="fb-masthead">
  <h1 id="fallback-heading">dipmeter</h1>
  <p class="fb-claim"><strong>${fmt(c.events)}</strong> located hypocentres against
  <strong>${manifest.zones.length}</strong> modelled slabs.</p>
  <p>Every located earthquake of magnitude ${c.magnitude.min} and above since
  ${manifest.counts.months.epochYear}, at its real depth inside the Earth, against the
  ${manifest.zones.length} subduction surfaces USGS actually modelled. Depths
  ${c.depthKm.min} to ${c.depthKm.max} km.</p>
  <p><strong>This is not a hazard map.</strong> It shows where earthquakes have been recorded.
  It does not forecast, and no probability or risk claim appears anywhere on this page.</p>
</header>

<p id="fallback-reason" hidden></p>

<h2>The whole dataset, without WebGL</h2>
<p>The interactive globe draws all ${fmt(c.events)} hypocentres. This page cannot: an SVG holding
${fmt(c.events)} marks is two orders of magnitude past what a browser will lay out. So this is a
declared decimation, and the ratio is printed rather than implied.</p>

<p class="decimation-receipt">${fmt(totalMarks)} marks drawn for ${fmt(c.events)} events, a
decimation of 1 in ${fmt(decimationRatio)}. The map collapses events into
${CELL_LON} by ${CELL_LAT} degree by ${CELL_DEPTH} km cells: ${fmt(occupiedCells)} of those cells are
occupied, falling to ${fmt(surface.size)} distinct surface cells, of which the
${fmt(mapDrawn)} deepest are drawn. The three depth sections draw
${sections.map((s) => fmt(s.drawn.length)).join(', ')} marks respectively, each an evenly strided
sample of its corridor at the ratio printed beneath it.</p>

<h2>Where the deep earthquakes are</h2>
<p>Each mark is one occupied cell, coloured by the deepest earthquake inside it. The cool colours
are not scattered: they trace the subduction zones, because only a slab descending into the mantle
carries earthquakes below 300 km.</p>
${mapSvg}

<h2>The dipping planes themselves</h2>
<p>A map cannot show a dip. These are vertical slices across three trenches, on the same axes a
seismology textbook uses: distance across strike on the horizontal, depth on the vertical. The
points make a plane sloping down and away from the trench. That plane is the subducting slab.</p>
<div class="fb-sections">
${sectionSvgs.map((s) => `<figure>
  <figcaption>${esc(s.label)}</figcaption>
  ${s.svg}
  <p class="decimation-receipt">${fmt(s.drawn)} of ${fmt(s.total)} events in this corridor drawn, every ${s.stride === 1 ? 'one' : fmt(s.stride)} in order.</p>
</figure>`).join('\n')}
</div>

<h2>Every depth regime</h2>
<table>
  <caption class="visually-hidden">Event counts by depth regime</caption>
  <thead><tr><th scope="col">Regime</th><th scope="col">Events</th><th scope="col">Share</th></tr></thead>
  <tbody>
    <tr><td>Shallow, 0 to 70 km</td><td class="num">${fmt(c.regimes.shallow)}</td><td class="num">${(100 * c.regimes.shallow / c.events).toFixed(1)}%</td></tr>
    <tr><td>Intermediate, 70 to 300 km</td><td class="num">${fmt(c.regimes.intermediate)}</td><td class="num">${(100 * c.regimes.intermediate / c.events).toFixed(1)}%</td></tr>
    <tr><td>Deep, 300 to 800 km</td><td class="num">${fmt(c.regimes.deep)}</td><td class="num">${(100 * c.regimes.deep / c.events).toFixed(1)}%</td></tr>
    <tr><td>of which deeper than 500 km</td><td class="num">${fmt(c.regimes.deeperThan500)}</td><td class="num">${(100 * c.regimes.deeperThan500 / c.events).toFixed(1)}%</td></tr>
    <tr><td>Above sea level (negative depth)</td><td class="num">${fmt(c.aboveSeaLevel)}</td><td class="num">${(100 * c.aboveSeaLevel / c.events).toFixed(3)}%</td></tr>
  </tbody>
</table>
<p>Those ${fmt(c.aboveSeaLevel)} negative-depth events are kept and named rather than clipped. A
catalogue that silently rounds ${c.depthKm.min} km up to 0 has been edited.</p>

<h2>What the depth axis is worth</h2>
<p><strong>${fmt(c.defaultDepth)} of ${fmt(c.events)} events
(${(100 * c.defaultDepth / c.events).toFixed(1)}%) sit at exactly ${DEFAULT_DEPTHS.join(', ')} or
${DEFAULT_DEPTHS[DEFAULT_DEPTHS.length - 1]} km.</strong> Those are the depths a locator assigns when it
cannot solve for one. They are drawn in grey on the globe, counted here, and can be switched off
entirely. Every one of them is shallower than 70 km, so the ${fmt(c.regimes.intermediate + c.regimes.deep)}
events that make up the dipping planes contain none of them.</p>

<h2>All ${manifest.zones.length} modelled slabs</h2>
<table>
  <caption class="visually-hidden">Slab2 subduction zones with attributed event counts</caption>
  <thead><tr><th scope="col">Zone</th><th scope="col">Code</th><th scope="col">Events</th><th scope="col">At 70 km or deeper</th><th scope="col">Modelled depth, km</th><th scope="col">Note</th></tr></thead>
  <tbody>${zoneRows}</tbody>
</table>
<p>An event is attributed to the slab whose modelled surface lies nearest to it vertically, and only
if that distance is under ${manifest.encoding.ATTRIBUTION_MAX_RESIDUAL_KM} km.
${fmt(c.attributedToASlab)} events meet that test and ${fmt(c.unattributed)} do not, which is
expected: mid-ocean ridges, transform faults and continental interiors have no slab under them.</p>

<p><strong>Split by depth, that ratio is the whole argument of this page.</strong> Of the
${fmt(deepTotal)} events at 70 km or deeper, <strong>${fmt(deepAttributed)}
(${(100 * deepAttributed / deepTotal).toFixed(1)}%)</strong> fall inside a modelled slab. Depth is
not distributed through the Earth; it is confined to ${manifest.zones.filter((z) => z.deepEvents > 0).length}
descending plates. ${esc(zeroDeep.length === 1 ? zeroDeep[0].name : zeroDeep.map((z) => z.name).join(', '))}
${zeroDeep.length === 1 ? 'is the one modelled zone with no deep seismicity at all' : 'are the modelled zones with no deep seismicity at all'},
which is a real property of that margin rather than a gap in the catalogue.</p>

<h2>Catalogue event types</h2>
<p>The query asked the catalogue for everything above magnitude 4.5, not only for earthquakes, so
that the exclusions could be counted rather than hidden by the server.</p>
<table>
  <caption class="visually-hidden">Events by catalogue type</caption>
  <thead><tr><th scope="col">Type</th><th scope="col">Events</th></tr></thead>
  <tbody>${typeRows}</tbody>
</table>

<h2>Search index: all ${fmt(manifest.regions.length)} catalogued regions</h2>
<p>The globe's search box matches against this list, which is the catalogue's own place names
reduced to the text after the last comma. It is reproduced in full here so the no-JavaScript
reader has the same index.</p>
<table>
  <caption class="visually-hidden">Every region name in the catalogue with its event count and centroid</caption>
  <thead><tr><th scope="col">Region</th><th scope="col">Events</th><th scope="col">Centroid lat, lon</th></tr></thead>
  <tbody>${regionRows}</tbody>
</table>
`;

  mkdirSync(join(ROOT, 'src'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'fallback.generated.html'), html);

  const stats = {
    generatedAt: new Date().toISOString(),
    markCeiling: MARK_CEILING,
    marksDrawn: totalMarks,
    mapMarks: mapDrawn,
    sectionMarks: sections.map((s) => ({ key: s.key, drawn: s.drawn.length, total: s.total, stride: s.stride })),
    occupiedCells,
    surfaceCells: surface.size,
    decimationRatio: Number(decimationRatio),
    htmlBytes: Buffer.byteLength(html),
  };
  writeFileSync(join(ROOT, 'docs', 'fallback-stats.json'), JSON.stringify(stats, null, 2));
  process.stdout.write('fallback: ' + totalMarks + ' marks (ceiling ' + MARK_CEILING + '), '
    + occupiedCells + ' occupied cells, ' + Buffer.byteLength(html) + ' B of HTML\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; }
}
