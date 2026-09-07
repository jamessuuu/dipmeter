#!/usr/bin/env node
// Turns the three vendored sources in data/raw/ into the binary payload the page loads,
// and writes public/data/manifest.json, which is the ONLY place the page gets a number from.
// Nothing in the UI is typed by hand. Re-run with `npm run build:data`.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readCatalogue, DEFAULT_DEPTHS } from './lib/comcat.mjs';
import { listZones, readGrid, sampleGrid, ZONE_NAMES, NODATA } from './lib/slab2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'public', 'data');

// ---- Encoding constants. Every one of these is also read by scripts/verify.mjs. --------
export const ENC = {
  LAT_SCALE: 364,      // int16, +/- 90 deg -> +/- 32760. 1/364 deg = about 0.3 km.
  LON_SCALE: 180,      // int16, +/- 180 deg -> +/- 32400. 1/180 deg = about 0.6 km at the equator.
  DEPTH_OFFSET: 100,   // km. Shifts the 74 above-sea-level events into unsigned range.
  DEPTH_SCALE: 50,     // uint16, 0.02 km resolution, ceiling (65535/50)-100 = 1210.7 km.
  // Magnitude is stored as tenths offset from 4.0: round(mag * 10) - 40. That makes the
  // quantum exactly 0.1, which is the precision a magnitude is reported and read at, and it
  // round-trips a one-decimal magnitude exactly. A previous 0.04-unit scale did not: it
  // turned 4.5 into 4.52 and 9.1 into 9.08, which scripts/verify.mjs caught.
  MAG_BASE: 4,
  MAG_TENTHS_OFFSET: 40,
  MAG_QUANTUM: 0.1,
  EPOCH_YEAR: 1990,    // uint16 month index.
  SLAB_SCALE: 10,      // int16 slab depth in 0.1 km units. NODATA = -32768.
  COAST_SCALE: 180,    // int16 lon/lat, same as events.
  SLAB_DECIMATE_DEG: 0.2, // target grid step for the shipped surfaces.
  ATTRIBUTION_MAX_RESIDUAL_KM: 300, // beyond this an event is not attributed to a slab at all.
};

// Flags, one uint8 per event.
export const FLAG_DEFAULT_DEPTH = 1 << 0;  // depth was assigned, not solved
export const FLAG_NOT_EARTHQUAKE = 1 << 1; // catalogue `type` is not "earthquake"

const MAGIC_EVENTS = 0x45504944; // "DIPE" little-endian
const MAGIC_SLABS = 0x53504944;  // "DIPS"
const MAGIC_COAST = 0x43504944;  // "DIPC"

function gz(buf) { return gzipSync(buf, { level: 9 }).length; }
function br(buf) {
  return brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}

// ---- Events ---------------------------------------------------------------------------

function monthIndex(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return (y - ENC.EPOCH_YEAR) * 12 + (m - 1);
}

function encodeEvents(events) {
  const n = events.length;
  const header = new ArrayBuffer(16);
  const hv = new DataView(header);
  hv.setUint32(0, MAGIC_EVENTS, true);
  hv.setUint32(4, 1, true);
  hv.setUint32(8, n, true);
  hv.setUint32(12, 0, true);

  const lat = new Int16Array(n);
  const lon = new Int16Array(n);
  const depth = new Uint16Array(n);
  const month = new Uint16Array(n);
  const mag = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const zone = new Uint8Array(n);
  const region = new Uint16Array(n);

  for (let i = 0; i < n; i += 1) {
    const e = events[i];
    lat[i] = Math.round(e.lat * ENC.LAT_SCALE);
    lon[i] = Math.round(e.lon * ENC.LON_SCALE);
    const d = Math.round((e.depth + ENC.DEPTH_OFFSET) * ENC.DEPTH_SCALE);
    if (d < 0 || d > 65535) throw new Error('Depth ' + e.depth + ' km does not fit the uint16 encoding.');
    depth[i] = d;
    month[i] = monthIndex(e.time);
    const m = Math.round(e.mag * 10) - ENC.MAG_TENTHS_OFFSET;
    if (m < 0 || m > 255) throw new Error('Magnitude ' + e.mag + ' does not fit the uint8 encoding.');
    mag[i] = m;
    flags[i] = e._flags;
    zone[i] = e._zone;
    region[i] = e._region;
  }

  return Buffer.concat([
    Buffer.from(header),
    Buffer.from(lat.buffer), Buffer.from(lon.buffer), Buffer.from(depth.buffer),
    Buffer.from(month.buffer), Buffer.from(region.buffer),
    Buffer.from(mag), Buffer.from(flags), Buffer.from(zone),
  ]);
}

// ---- Slab surfaces --------------------------------------------------------------------

function encodeSlabs(zoneGrids) {
  // Per zone: a decimated regular grid of int16 depths in 0.1 km units, NODATA where the
  // model does not reach. The client walks the grid and emits a triangle only where all
  // four corners exist, so a slab edge is never bridged with invented geometry.
  const parts = [];
  const index = [];
  let offset = 0;
  for (const z of zoneGrids) {
    const g = z.grid;
    const f = Math.max(1, Math.round(ENC.SLAB_DECIMATE_DEG / g.step));
    const nx = Math.floor((g.nx - 1) / f) + 1;
    const ny = Math.floor((g.ny - 1) / f) + 1;
    const arr = new Int16Array(nx * ny);
    let valid = 0;
    let dMin = Infinity, dMax = -Infinity;
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const d = g.depths[(iy * f) * g.nx + (ix * f)];
        if (d === d) {
          arr[iy * nx + ix] = Math.round(d * ENC.SLAB_SCALE);
          valid += 1;
          if (d < dMin) dMin = d;
          if (d > dMax) dMax = d;
        } else {
          arr[iy * nx + ix] = NODATA;
        }
      }
    }
    const buf = Buffer.from(arr.buffer);
    parts.push(buf);
    index.push({
      code: z.code,
      name: z.name,
      lonMin: +g.lonMin.toFixed(4),
      latMin: +g.latMin.toFixed(4),
      step: +(g.step * f).toFixed(4),
      nx, ny,
      sourceNx: g.nx, sourceNy: g.ny, sourceStep: g.step,
      sourceNodes: g.rows, sourceValidNodes: g.valid,
      shippedNodes: nx * ny, shippedValidNodes: valid,
      depthMinKm: dMin === Infinity ? null : +dMin.toFixed(2),
      depthMaxKm: dMax === -Infinity ? null : +dMax.toFixed(2),
      byteOffset: offset,
      byteLength: buf.length,
      overturns: z.overturns,
    });
    offset += buf.length;
  }
  const header = new ArrayBuffer(16);
  const hv = new DataView(header);
  hv.setUint32(0, MAGIC_SLABS, true);
  hv.setUint32(4, 1, true);
  hv.setUint32(8, zoneGrids.length, true);
  hv.setUint32(12, 0, true);
  for (const e of index) e.byteOffset += 16;
  return { buffer: Buffer.concat([Buffer.from(header), ...parts]), index };
}

// ---- Coastlines -----------------------------------------------------------------------

function encodeCoast(geojsonPath) {
  const gj = JSON.parse(readFileSync(geojsonPath, 'utf8'));
  const lines = [];
  let points = 0;
  for (const feat of gj.features) {
    const g = feat.geometry;
    if (!g) continue;
    const strands = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const s of strands) {
      if (s.length < 2) continue;
      lines.push(s);
      points += s.length;
    }
  }
  const header = new ArrayBuffer(16);
  const hv = new DataView(header);
  hv.setUint32(0, MAGIC_COAST, true);
  hv.setUint32(4, 1, true);
  hv.setUint32(8, lines.length, true);
  hv.setUint32(12, points, true);

  const lengths = new Uint32Array(lines.length);
  const coords = new Int16Array(points * 2);
  let k = 0;
  lines.forEach((s, i) => {
    lengths[i] = s.length;
    for (const [lon, lat] of s) {
      coords[k++] = Math.round(Math.max(-180, Math.min(180, lon)) * ENC.COAST_SCALE);
      coords[k++] = Math.round(Math.max(-90, Math.min(90, lat)) * ENC.COAST_SCALE);
    }
  });
  return {
    buffer: Buffer.concat([Buffer.from(header), Buffer.from(lengths.buffer), Buffer.from(coords.buffer)]),
    strands: lines.length,
    points,
  };
}

// ---------------------------------------------------------------------------------------

export function main() {
  mkdirSync(OUT, { recursive: true });
  const csvPath = join(RAW, 'comcat-m45-1990-2026.csv');
  const { events: allEvents, skippedIncomplete, totalLines } = readCatalogue(csvPath);

  // The FDSN query asked for minmagnitude=4.5, but the service matches on a magnitude that is
  // not always the one it then reports as preferred, so a small number of sub-4.5 events come
  // back anyway. The brief's cut list forbids anything below 4.5, because catalogue
  // completeness falls apart there and a global picture from an incomplete catalogue is a
  // picture of detector coverage. They are dropped here and named in the manifest.
  const belowFloor = allEvents.filter((e) => e.mag < 4.5);
  const events = allEvents.filter((e) => e.mag >= 4.5);

  // Quantise NOW, before anything is counted. The page renders the quantised values, so every
  // count it prints must describe the quantised values: otherwise a headline figure would
  // describe a dataset the visitor is not looking at. The quantum is stated in the manifest
  // and in the README, and scripts/verify.mjs re-derives it from the CSV to check the binary.
  for (const e of events) {
    e.rawDepth = e.depth;
    e.rawMag = e.mag;
    e.depth = Math.round((e.depth + ENC.DEPTH_OFFSET) * ENC.DEPTH_SCALE) / ENC.DEPTH_SCALE - ENC.DEPTH_OFFSET;
    e.mag = (Math.round(e.mag * 10)) / 10;
  }
  process.stdout.write('catalogue: ' + allEvents.length + ' parsed from ' + totalLines + ' data rows; '
    + belowFloor.length + ' below the M4.5 floor dropped; ' + events.length + ' kept\n');

  // ---- Slab grids, read once and reused for attribution and for the shipped surfaces ----
  const xyzDir = join(RAW, 'slab2-xyz');
  const nodeDir = join(RAW, 'slab2-nodes');
  const overturning = new Set(
    (function () {
      try {
        const m = JSON.parse(readFileSync(join(RAW, 'slab2-fetch-manifest.json'), 'utf8'));
        return m.supplementaryNodeFiles.files.map((f) => f.slice(0, 3));
      } catch { return []; }
    })()
  );
  const zoneGrids = listZones(xyzDir).map((z) => {
    const grid = readGrid(join(xyzDir, z.file));
    process.stdout.write('  slab ' + z.code + ' ' + grid.nx + 'x' + grid.ny + ' step ' + grid.step
      + ' valid ' + grid.valid + '\n');
    return { code: z.code, name: ZONE_NAMES[z.code] || z.code, grid, overturns: overturning.has(z.code) };
  });

  // ---- Attribution, flags, magnitude tiers ---------------------------------------------
  const zoneOrder = zoneGrids.map((z) => z.code);
  const zoneCounts = Object.fromEntries(zoneOrder.map((c) => [c, 0]));
  const zoneDeepCounts = Object.fromEntries(zoneOrder.map((c) => [c, 0]));
  let unattributed = 0;
  let defaultDepthCount = 0;
  let notEarthquakeCount = 0;
  const typeCounts = {};
  let depthMin = Infinity, depthMax = -Infinity, magMin = Infinity, magMax = -Infinity;
  let aboveSeaLevel = 0;
  const regimes = { shallow: 0, intermediate: 0, deep: 0, deeperThan500: 0 };

  // Region identity comes from the catalogue's own `place` field, reduced to the text after
  // the last comma, which is how ComCat writes it ("125 km NE of X, Country"). Centroids are
  // averaged as unit vectors on the sphere, so a region straddling the date line (Fiji, and
  // it is the single densest deep-focus region on Earth) does not average to the Atlantic.
  const regionIds = new Map();
  const regionTable = { names: [], counts: [], vx: [], vy: [], vz: [], latSum: [], lonSum: [], span: [] };
  const toName = (place) => {
    const parts = place.split(',');
    return (parts[parts.length - 1] || '').trim() || 'Unnamed region';
  };

  for (const e of events) {
    const rname = toName(e.place);
    let rid = regionIds.get(rname);
    if (rid === undefined) {
      rid = regionTable.names.length;
      regionIds.set(rname, rid);
      regionTable.names.push(rname);
      regionTable.counts.push(0);
      regionTable.vx.push(0); regionTable.vy.push(0); regionTable.vz.push(0);
      regionTable.latSum.push(0); regionTable.lonSum.push(0); regionTable.span.push(0);
    }
    if (rid > 65535) throw new Error('More than 65536 regions; the uint16 region id no longer fits.');
    e._region = rid;
    const la = e.lat * Math.PI / 180, lo = e.lon * Math.PI / 180;
    regionTable.counts[rid] += 1;
    regionTable.vx[rid] += Math.cos(la) * Math.cos(lo);
    regionTable.vy[rid] += Math.cos(la) * Math.sin(lo);
    regionTable.vz[rid] += Math.sin(la);
  }
  for (let i = 0; i < regionTable.names.length; i += 1) {
    const x = regionTable.vx[i], y = regionTable.vy[i], z = regionTable.vz[i];
    const len = Math.hypot(x, y, z) || 1;
    regionTable.latSum[i] = Math.asin(z / len) * 180 / Math.PI * regionTable.counts[i];
    regionTable.lonSum[i] = Math.atan2(y, x) * 180 / Math.PI * regionTable.counts[i];
  }
  // Angular span: the largest great-circle distance from the centroid, in degrees. The
  // camera uses it so that searching a small region does not frame the whole hemisphere.
  for (const e of events) {
    const i = e._region;
    const clat = regionTable.latSum[i] / regionTable.counts[i];
    const clon = regionTable.lonSum[i] / regionTable.counts[i];
    const a = clat * Math.PI / 180, b = e.lat * Math.PI / 180;
    let dLon = (e.lon - clon) * Math.PI / 180;
    const cosd = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dLon);
    const d = Math.acos(Math.max(-1, Math.min(1, cosd))) * 180 / Math.PI;
    if (d > regionTable.span[i]) regionTable.span[i] = d;
  }

  for (const e of events) {
    let flags = 0;
    for (const d of DEFAULT_DEPTHS) if (Math.abs(e.depth - d) < 1e-9) { flags |= FLAG_DEFAULT_DEPTH; break; }
    if (e.type !== 'earthquake') flags |= FLAG_NOT_EARTHQUAKE;
    if (flags & FLAG_DEFAULT_DEPTH) defaultDepthCount += 1;
    if (flags & FLAG_NOT_EARTHQUAKE) notEarthquakeCount += 1;
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    e._flags = flags;

    let best = null;
    for (let zi = 0; zi < zoneGrids.length; zi += 1) {
      const g = zoneGrids[zi].grid;
      const lonB = e.lon < 0 ? e.lon + 360 : e.lon - 360;
      const s = sampleGrid(g, e.lon, e.lat) ?? sampleGrid(g, lonB, e.lat);
      if (s === null) continue;
      const r = Math.abs(e.depth - s);
      if (best === null || r < best.r) best = { zi, r };
    }
    if (best && best.r <= ENC.ATTRIBUTION_MAX_RESIDUAL_KM) {
      e._zone = best.zi + 1;
      const code = zoneOrder[best.zi];
      zoneCounts[code] += 1;
      if (e.depth >= 70) zoneDeepCounts[code] += 1;
    } else {
      e._zone = 0;
      unattributed += 1;
    }

    if (e.depth < depthMin) depthMin = e.depth;
    if (e.depth > depthMax) depthMax = e.depth;
    if (e.mag < magMin) magMin = e.mag;
    if (e.mag > magMax) magMax = e.mag;
    if (e.depth < 0) aboveSeaLevel += 1;
    if (e.depth < 70) regimes.shallow += 1;
    else if (e.depth < 300) regimes.intermediate += 1;
    else regimes.deep += 1;
    if (e.depth > 500) regimes.deeperThan500 += 1;
  }

  const tierA = events.filter((e) => e.mag >= 5.0);
  const tierB = events.filter((e) => e.mag < 5.0);
  process.stdout.write('tier A (M5.0+): ' + tierA.length + ', tier B (M4.5-4.9): ' + tierB.length + '\n');

  const bufA = encodeEvents(tierA);
  const bufB = encodeEvents(tierB);
  writeFileSync(join(OUT, 'events-a.bin'), bufA);
  writeFileSync(join(OUT, 'events-b.bin'), bufB);

  const slabs = encodeSlabs(zoneGrids);
  writeFileSync(join(OUT, 'slabs.bin'), slabs.buffer);

  const coast = encodeCoast(join(RAW, 'ne_110m_coastline.geojson'));
  writeFileSync(join(OUT, 'coast.bin'), coast.buffer);

  const regions = regionTable.names.map((name, i) => ({
    name,
    count: regionTable.counts[i],
    lat: +(regionTable.latSum[i] / regionTable.counts[i]).toFixed(3),
    lon: +(regionTable.lonSum[i] / regionTable.counts[i]).toFixed(3),
    span: +regionTable.span[i].toFixed(2),
  }));

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/build-data.mjs',
    encoding: ENC,
    flags: { FLAG_DEFAULT_DEPTH, FLAG_NOT_EARTHQUAKE },
    sources: {
      comcat: {
        name: 'USGS ANSS ComCat, M4.5+, 1990-01-01 to 2026-01-01',
        endpoint: 'https://earthquake.usgs.gov/fdsnws/event/1/query',
        licence: 'U.S. Public Domain',
        fetchedAt: JSON.parse(readFileSync(join(RAW, 'comcat-fetch-manifest.json'), 'utf8')).fetchedAt,
        csvBytes: statSync(csvPath).size,
        dataRows: totalLines,
        parsedRows: allEvents.length,
        skippedIncomplete,
        droppedBelowMagnitudeFloor: {
          count: belowFloor.length,
          reason: 'The FDSN service matched these on a magnitude other than the preferred one it reports. The brief forbids anything below M4.5.',
          events: belowFloor.map((e) => ({ id: e.id, time: e.time, mag: e.mag, magType: e.magType, place: e.place })),
        },
        keptEvents: events.length,
      },
      slab2: {
        name: 'USGS Slab2, Hayes et al. 2018',
        item: 'https://www.sciencebase.gov/catalog/item/5aa1b00ee4b0b1c392e86467',
        doi: '10.5066/F7PV6JNV',
        licence: 'U.S. Public Domain',
        fetchedAt: JSON.parse(readFileSync(join(RAW, 'slab2-fetch-manifest.json'), 'utf8')).fetchedAt,
        zones: zoneGrids.length,
        overturningZones: zoneGrids.filter((z) => z.overturns).map((z) => ({ code: z.code, name: z.name })),
      },
      naturalEarth: {
        name: 'Natural Earth 1:110m coastline',
        url: 'https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_coastline.geojson',
        licence: 'Public domain',
        geojsonBytes: statSync(join(RAW, 'ne_110m_coastline.geojson')).size,
        strands: coast.strands,
        points: coast.points,
      },
    },
    counts: {
      events: events.length,
      tierA: tierA.length,
      tierB: tierB.length,
      defaultDepth: defaultDepthCount,
      notEarthquake: notEarthquakeCount,
      byType: typeCounts,
      aboveSeaLevel,
      attributedToASlab: events.length - unattributed,
      unattributed,
      regimes,
      depthKm: { min: +depthMin.toFixed(2), max: +depthMax.toFixed(2) },
      magnitude: { min: +magMin.toFixed(2), max: +magMax.toFixed(2) },
      quantisation: {
        depthKm: 1 / ENC.DEPTH_SCALE,
        magnitude: ENC.MAG_QUANTUM,
        latitudeDeg: 1 / ENC.LAT_SCALE,
        longitudeDeg: 1 / ENC.LON_SCALE,
        note: 'Counts and extremes above describe the quantised values the page actually renders, not the raw CSV decimals.',
      },
      // Spread-into-Math.max blows the stack at this length; fold instead.
      months: {
        epochYear: ENC.EPOCH_YEAR,
        count: events.reduce((m, e) => Math.max(m, monthIndex(e.time)), 0) + 1,
        firstEvent: events[0].time,
        lastEvent: events[events.length - 1].time,
      },
    },
    zones: slabs.index.map((z) => ({
      ...z,
      events: zoneCounts[z.code],
      deepEvents: zoneDeepCounts[z.code],
    })),
    regions,
    payload: {
      'events-a.bin': { raw: bufA.length, gzip: gz(bufA), brotli: br(bufA), events: tierA.length, bytesPerEvent: +(bufA.length / tierA.length).toFixed(2) },
      'events-b.bin': { raw: bufB.length, gzip: gz(bufB), brotli: br(bufB), events: tierB.length, bytesPerEvent: +(bufB.length / tierB.length).toFixed(2) },
      'slabs.bin': { raw: slabs.buffer.length, gzip: gz(slabs.buffer), brotli: br(slabs.buffer) },
      'coast.bin': { raw: coast.buffer.length, gzip: gz(coast.buffer), brotli: br(coast.buffer) },
    },
  };
  manifest.payload.total = {
    raw: bufA.length + bufB.length + slabs.buffer.length + coast.buffer.length,
    gzip: manifest.payload['events-a.bin'].gzip + manifest.payload['events-b.bin'].gzip
      + manifest.payload['slabs.bin'].gzip + manifest.payload['coast.bin'].gzip,
    brotli: manifest.payload['events-a.bin'].brotli + manifest.payload['events-b.bin'].brotli
      + manifest.payload['slabs.bin'].brotli + manifest.payload['coast.bin'].brotli,
  };

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  process.stdout.write('\nPayload:\n');
  for (const [k, v] of Object.entries(manifest.payload)) {
    process.stdout.write('  ' + k.padEnd(14) + ' raw ' + String(v.raw).padStart(9)
      + '  gzip ' + String(v.gzip).padStart(9) + '  brotli ' + String(v.brotli).padStart(9) + '\n');
  }
  process.stdout.write('\nEvents ' + events.length + ', slabs ' + zoneGrids.length
    + ', unattributed ' + unattributed + ', default-depth ' + defaultDepthCount + '\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; }
}
