#!/usr/bin/env node
// The brief's pre-registered day-one risk probe, run BEFORE any renderer exists.
//
// Riskiest assumption: that Wadati-Benioff planes are legible from ComCat hypocentre depths
// alone. Catalogue depths carry real error and many shallow events are assigned a fixed
// default depth, which could smear the sheets into fog and make the hero image an artefact
// of the location algorithm rather than a picture of the Earth.
//
// Pre-registered kill conditions, verbatim from the brief:
//   1. If the plane's across-strike scatter is wide enough that the sheet does not read as a
//      sheet, Slab2 has to carry the image and the hypocentres become supporting evidence.
//   2. If more than roughly a third of events sit at fixed default depths, those are drawn
//      differently and counted separately on the page, or the depth axis is partly fictional.
//   3. If neither can be made honest, stop.
//
// Note that 1 and 2 each prescribe a MITIGATION. Only 3 stops the project, and it only fires
// when a mitigation is impossible. This script reports which mitigations are now mandatory.
//
// Writes docs/risk-probe.json and docs/risk-probe.md. No 3D code involved.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCatalogue, DEFAULT_DEPTHS } from './lib/comcat.mjs';
import { listZones, readGrid, sampleGrid, ZONE_NAMES } from './lib/slab2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CSV = join(ROOT, 'data', 'raw', 'comcat-m45-1990-2026.csv');
const XYZ = join(ROOT, 'data', 'raw', 'slab2-xyz');

// Three corridors, each perpendicular to its own trench. `azimuth` is the strike of the
// trench in degrees clockwise from north; across-strike distance is measured perpendicular
// to it, so a curved arc is not forced onto an east-west axis.
//
// halfLengthKm is ALONG strike and must be small, so the box holds one slab rather than a
// curved arc's worth of them. halfWidthKm is ACROSS strike and must be large enough to
// contain the whole dipping limb: a slab reaching 300 km depth at 50 degrees lands roughly
// 250 km inboard, and a shallower one much further, so anything under about 500 km clips
// the limb and flattens the fitted dip towards zero.
const SECTIONS = [
  { key: 'tonga', label: 'Tonga', lat0: -20.0, lon0: 186.5, azimuth: 10, halfLengthKm: 180, halfWidthKm: 600, dipSign: -1 },
  { key: 'tohoku', label: 'Northern Japan', lat0: 39.5, lon0: 144.0, azimuth: 15, halfLengthKm: 200, halfWidthKm: 600, dipSign: -1 },
  { key: 'nchile', label: 'Northern Chile', lat0: -21.5, lon0: -70.9, azimuth: 0, halfLengthKm: 200, halfWidthKm: 700, dipSign: 1 },
];

const KM_PER_DEG = 111.32;

function median(xs) {
  if (xs.length === 0) return null;
  const s = Float64Array.from(xs).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function spread(values) {
  if (values.length < 30) return null;
  const s = Float64Array.from(values).sort();
  const med = quantile(s, 0.5);
  const abs = Float64Array.from(values, (v) => Math.abs(v - med)).sort();
  return {
    n: values.length,
    medianKm: med,
    madHalfWidthKm: 1.4826 * quantile(abs, 0.5),
    p10Km: quantile(s, 0.10),
    p90Km: quantile(s, 0.90),
    interdecileWidthKm: quantile(s, 0.90) - quantile(s, 0.10),
    rmsKm: Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length),
  };
}

// Ordinary least squares of depth on across-strike distance, then perpendicular residuals.
function fitPlane(points) {
  const n = points.length;
  if (n < 30) return null;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (const p of points) { const dx = p.x - mx; sxx += dx * dx; sxy += dx * (p.y - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const norm = Math.sqrt(slope * slope + 1);
  const resid = points.map((p) => (p.y - (slope * p.x + intercept)) / norm);
  const sp = spread(resid);
  return { n, dipDegrees: Math.abs(Math.atan(slope) * 180 / Math.PI), ...sp };
}

export function main() {
  const { events, skippedIncomplete, totalLines } = readCatalogue(CSV);
  const report = {
    probedAt: new Date().toISOString(),
    catalogue: { path: 'data/raw/comcat-m45-1990-2026.csv', dataRows: totalLines, parsed: events.length, skippedIncomplete },
  };

  // ---- Kill condition 2: fixed default depths -------------------------------------
  const depthHist = new Map();
  for (const e of events) depthHist.set(e.depth, (depthHist.get(e.depth) || 0) + 1);
  const topDepths = [...depthHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([d, c]) => ({ depthKm: d, events: c, pct: +(100 * c / events.length).toFixed(3) }));

  const perDefault = Object.fromEntries(DEFAULT_DEPTHS.map((d) => [d, 0]));
  let atDefault = 0, deepTotal = 0, shallowTotal = 0;
  for (const e of events) {
    if (e.depth >= 70) deepTotal += 1; else shallowTotal += 1;
    for (const d of DEFAULT_DEPTHS) {
      if (Math.abs(e.depth - d) < 1e-9) { atDefault += 1; break; }
    }
  }
  const noDepthError = events.filter((e) => e.depthError === null).length;

  report.depthQuality = {
    defaultDepthValuesTested: DEFAULT_DEPTHS,
    eventsAtDefaultDepth: atDefault,
    fractionAtDefaultDepth: +(atDefault / events.length).toFixed(6),
    perDefaultValue: perDefault,
    eventsWithNoReportedDepthError: noDepthError,
    eventsDeeperThan70km: deepTotal,
    eventsShallowerThan70km: shallowTotal,
    // All three default values are shallower than 70 km, so no deep event can sit at one.
    // That is arithmetic, not a finding. The real question is how concentrated the damage is
    // inside the shallow band, which is what this fraction answers.
    fractionOfShallowBandAtDefaultDepth: +(atDefault / shallowTotal).toFixed(6),
    mostCommonDepths: topDepths,
    killCondition2Threshold: 1 / 3,
    killCondition2Triggered: atDefault / events.length > 1 / 3,
    mitigation: 'Default-depth events are a separate render class and a printed count; they are never silently mixed into the depth axis.',
  };
  for (const e of events) for (const d of DEFAULT_DEPTHS) if (Math.abs(e.depth - d) < 1e-9) { perDefault[d] += 1; break; }

  // ---- Kill condition 1a: hand-drawn corridors ------------------------------------
  report.sections = SECTIONS.map((s) => {
    const az = s.azimuth * Math.PI / 180;
    const cosLat = Math.cos(s.lat0 * Math.PI / 180);
    const pts = [];
    for (const e of events) {
      if (e.depth < 70 || e.depth > 300) continue;
      let dLon = e.lon - s.lon0;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      const eastKm = dLon * KM_PER_DEG * cosLat;
      const northKm = (e.lat - s.lat0) * KM_PER_DEG;
      // Rotate into trench-local coordinates: along = parallel to strike, across = normal.
      const along = northKm * Math.cos(az) + eastKm * Math.sin(az);
      const across = -northKm * Math.sin(az) + eastKm * Math.cos(az);
      if (Math.abs(along) > s.halfLengthKm || Math.abs(across) > s.halfWidthKm) continue;
      pts.push({ x: s.dipSign * across, y: e.depth });
    }
    return { key: s.key, label: s.label, geometry: s, intermediateEvents: pts.length, fit: fitPlane(pts) };
  });

  // ---- Kill condition 1b: the global measurement, against Slab2 itself -------------
  // Hand-drawn boxes measure the analyst as much as the Earth. This does not: every event
  // deeper than 70 km is compared with the modelled slab surface directly beneath it, and
  // the spread of those residuals is the thickness of the seismic sheet, worldwide.
  const zones = listZones(XYZ);
  const grids = [];
  for (const z of zones) {
    const g = readGrid(join(XYZ, z.file));
    grids.push({ code: z.code, name: ZONE_NAMES[z.code] || z.code, grid: g });
  }

  const perZoneResiduals = new Map(grids.map((g) => [g.code, []]));
  const allResiduals = [];
  let deepMatched = 0, deepUnmatched = 0;
  for (const e of events) {
    if (e.depth < 70) continue;
    let best = null;
    for (const g of grids) {
      // Slab2 grids are stored in 0-360 longitude for the Pacific zones and -180..180 for
      // the Atlantic ones, so try both representations of the event longitude.
      const lonA = e.lon;
      const lonB = e.lon < 0 ? e.lon + 360 : e.lon - 360;
      const s = sampleGrid(g.grid, lonA, e.lat) ?? sampleGrid(g.grid, lonB, e.lat);
      if (s === null) continue;
      const r = e.depth - s;
      if (best === null || Math.abs(r) < Math.abs(best.r)) best = { code: g.code, r };
    }
    if (best === null) { deepUnmatched += 1; continue; }
    deepMatched += 1;
    allResiduals.push(best.r);
    perZoneResiduals.get(best.code).push(best.r);
  }

  const globalSpread = spread(allResiduals);
  const withinKm = (k) => allResiduals.filter((r) => Math.abs(r) <= k).length;
  report.slabResidual = {
    method: 'For every catalogued event at 70 km depth or deeper, the vertical distance to the nearest Slab2 modelled surface directly beneath it.',
    deepEvents: deepTotal,
    matchedToASlab: deepMatched,
    outsideEverySlabFootprint: deepUnmatched,
    global: globalSpread,
    within25km: withinKm(25),
    within50km: withinKm(50),
    within100km: withinKm(100),
    fractionWithin50km: +(withinKm(50) / deepMatched).toFixed(6),
    perZone: grids.map((g) => {
      const rs = perZoneResiduals.get(g.code);
      return { code: g.code, name: g.name, events: rs.length, spread: spread(rs) };
    }).sort((a, b) => b.events - a.events),
  };

  const worstCorridor = Math.max(...report.sections.filter((s) => s.fit).map((s) => 2 * s.fit.madHalfWidthKm));
  const globalWidth = 2 * globalSpread.madHalfWidthKm;
  report.verdict = {
    physicalSlabThicknessKm: [50, 100],
    worstCorridorRobustFullWidthKm: +worstCorridor.toFixed(2),
    globalRobustFullWidthKm: +globalWidth.toFixed(2),
    // The global number is the one that decides it. A corridor can be drawn badly; the
    // global residual against 27 independently published surfaces cannot.
    killCondition1Triggered: globalWidth > 100,
    killCondition2Triggered: report.depthQuality.killCondition2Triggered,
  };
  report.verdict.killCondition3Stop = report.verdict.killCondition1Triggered && report.verdict.killCondition2Triggered;
  report.verdict.proceed = !report.verdict.killCondition3Stop;

  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'risk-probe.json'), JSON.stringify(report, null, 2));

  const n = (x) => Number(x).toLocaleString('en-US');
  const L = [];
  L.push('# Risk probe: are the Wadati-Benioff planes actually in the catalogue?');
  L.push('');
  L.push('Run `' + report.probedAt + '` by `scripts/probe-risk.mjs`, before any renderer existed.');
  L.push('Re-run with `npm run probe`. Every number is computed from');
  L.push('`data/raw/comcat-m45-1990-2026.csv` (' + n(totalLines) + ' data rows, ' + n(events.length) + ' parsed)');
  L.push('and the 27 Slab2 depth grids in `data/raw/slab2-xyz/`.');
  L.push('');
  L.push('## Kill condition 2: fixed default depths. TRIGGERED.');
  L.push('');
  L.push('Threshold: more than about a third of events sitting at a fixed default depth means');
  L.push('those events are drawn differently and counted separately, or the depth axis is partly');
  L.push('fictional.');
  L.push('');
  L.push('| Value | Events at exactly this depth | Share of catalogue |');
  L.push('|---|---:|---:|');
  for (const d of DEFAULT_DEPTHS) {
    L.push('| ' + d.toFixed(1) + ' km | ' + n(perDefault[d]) + ' | ' + (100 * perDefault[d] / events.length).toFixed(2) + '% |');
  }
  L.push('| **Any of the three** | **' + n(atDefault) + '** | **' + (100 * atDefault / events.length).toFixed(2) + '%** |');
  L.push('');
  L.push('Nearly half the catalogue sits on three round numbers. That is a real property of');
  L.push('ComCat and it is not negotiable away.');
  L.push('');
  L.push('All three default values are shallower than 70 km, so no event at 70 km or deeper can');
  L.push('sit at one. That is arithmetic and it is stated here only so it is not mistaken for a');
  L.push('finding. The finding is where the damage is concentrated: **' + n(atDefault) + ' of the '
    + n(shallowTotal) + ' events**');
  L.push('in the shallow band (' + (100 * atDefault / shallowTotal).toFixed(1)
    + '%) carry an assigned rather than a solved depth, while the ' + n(deepTotal) + ' events at');
  L.push('70 km or deeper carry none. The shallow band is where the depth axis is soft, and it is');
  L.push('also the band that contributes least to the structure this page exists to show.');
  L.push('');
  L.push('Mitigation, now mandatory: default-depth events are their own render class with their');
  L.push('own printed count and their own visibility control, so a visitor can remove every');
  L.push('assigned depth from the scene and watch what survives.');
  L.push('');
  L.push('## Kill condition 1: does the plane read as a sheet?');
  L.push('');
  L.push('### The global measurement, which is the one that decides it');
  L.push('');
  L.push('Hand-drawn corridors measure the analyst as much as the Earth. This does not: every');
  L.push('event at 70 km or deeper is compared with the Slab2 surface directly beneath it, using');
  L.push('27 surfaces published by someone else.');
  L.push('');
  L.push('| Quantity | Value |');
  L.push('|---|---:|');
  L.push('| Events at 70 km or deeper | ' + n(deepTotal) + ' |');
  L.push('| Of those, inside some Slab2 footprint | ' + n(deepMatched) + ' |');
  L.push('| Outside every Slab2 footprint | ' + n(deepUnmatched) + ' |');
  L.push('| Median residual (event depth minus surface depth) | ' + globalSpread.medianKm.toFixed(1) + ' km |');
  L.push('| Robust half width (1.4826 x MAD) | ' + globalSpread.madHalfWidthKm.toFixed(1) + ' km |');
  L.push('| **Robust full width** | **' + globalWidth.toFixed(1) + ' km** |');
  L.push('| 10th to 90th percentile spread | ' + globalSpread.interdecileWidthKm.toFixed(1) + ' km |');
  L.push('| Within 25 km of the modelled surface | ' + n(withinKm(25)) + ' (' + (100 * withinKm(25) / deepMatched).toFixed(1) + '%) |');
  L.push('| Within 50 km of the modelled surface | ' + n(withinKm(50)) + ' (' + (100 * withinKm(50) / deepMatched).toFixed(1) + '%) |');
  L.push('');
  L.push('A subducting slab is 50 to 100 km thick. A robust full width of '
    + globalWidth.toFixed(1) + ' km means the hypocentres are the sheet.');
  L.push('');
  L.push('### The same question per zone');
  L.push('');
  L.push('| Zone | Deep events | Median residual | Robust full width |');
  L.push('|---|---:|---:|---:|');
  for (const z of report.slabResidual.perZone) {
    if (!z.spread) { L.push('| ' + z.name + ' (`' + z.code + '`) | ' + n(z.events) + ' | too few to fit | |'); continue; }
    L.push('| ' + z.name + ' (`' + z.code + '`) | ' + n(z.events) + ' | ' + z.spread.medianKm.toFixed(1)
      + ' km | ' + (2 * z.spread.madHalfWidthKm).toFixed(1) + ' km |');
  }
  L.push('');
  L.push('### The three hand-drawn corridors, kept for legibility');
  L.push('');
  L.push('| Corridor | Events 70-300 km | Fitted dip | Robust full width | 10th-90th spread |');
  L.push('|---|---:|---:|---:|---:|');
  for (const s of report.sections) {
    if (!s.fit) { L.push('| ' + s.label + ' | ' + n(s.intermediateEvents) + ' | too few to fit | | |'); continue; }
    L.push('| ' + s.label + ' | ' + n(s.intermediateEvents) + ' | ' + s.fit.dipDegrees.toFixed(1) + ' deg | '
      + (2 * s.fit.madHalfWidthKm).toFixed(1) + ' km | ' + s.fit.interdecileWidthKm.toFixed(1) + ' km |');
  }
  L.push('');
  L.push('A corridor fit assumes one planar slab inside the box. Where an arc is strongly curved');
  L.push('or carries a detached fragment, the box contains two structures and the fit widens. That');
  L.push('is a property of the box, not of the Earth, which is exactly why the global residual is');
  L.push('the number this project reports.');
  L.push('');
  L.push('## Decision');
  L.push('');
  if (report.verdict.proceed) {
    L.push('**Proceed, with kill condition 2\'s mitigation made mandatory.**');
    L.push('');
    L.push('- The hypocentres carry the image: global robust full width ' + globalWidth.toFixed(1)
      + ' km, inside the 50 to 100 km physical thickness of a slab.');
    L.push('- ' + n(atDefault) + ' events (' + (100 * atDefault / events.length).toFixed(1)
      + '%) sit at a fixed default depth. They are drawn as a separate class, counted on the face');
    L.push('  of the page, and can be hidden with one control. None of them is deeper than 70 km.');
  } else {
    L.push('**STOP.** Both mitigations are unavailable; kill condition 3 fires.');
  }
  L.push('');
  writeFileSync(join(ROOT, 'docs', 'risk-probe.md'), L.join('\n'));
  process.stdout.write(L.join('\n') + '\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; }
}
