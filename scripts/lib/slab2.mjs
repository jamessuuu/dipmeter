// Slab2 depth-grid reader.
//
// Each Slab2_TXT/*_dep_*.xyz is the ASCII twin of the matching netCDF-4 .grd: one
// "lon,lat,depth" row per grid node, row-major, 0.05 degree spacing in both axes, with the
// literal string NaN wherever the model does not extend. Depths are negative kilometres
// (below sea level), which we flip to positive-down to match the ComCat convention.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ZONE_NAMES = {
  alu: 'Alaska-Aleutians', cal: 'Calabria', cam: 'Central America', car: 'Caribbean',
  cas: 'Cascadia', cot: 'Cotabato', hal: 'Halmahera', hel: 'Hellenic',
  him: 'Himalaya', hin: 'Hindu Kush', izu: 'Izu-Bonin', ker: 'Kermadec-Tonga',
  kur: 'Kuril-Kamchatka-Japan', mak: 'Makran', man: 'Manila', mue: 'Muertos Trough',
  pam: 'Pamir', phi: 'Philippines', png: 'New Guinea', puy: 'Puysegur',
  ryu: 'Ryukyu', sam: 'South America', sco: 'Scotia Sea', sol: 'Solomon Islands',
  sul: 'Sulawesi', sum: 'Sumatra-Java', van: 'Vanuatu',
};

export const NODATA = -32768;

export function listZones(xyzDir) {
  return readdirSync(xyzDir)
    .filter((f) => /^[a-z]{3}_slab2_dep_[^/]*\.xyz$/.test(f))
    .map((f) => ({ code: f.slice(0, 3), file: f }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// Parses one .xyz into a regular lon/lat grid. Returns positive-down depths in km,
// with null for nodes the model does not cover.
export function readGrid(path) {
  const text = readFileSync(path, 'utf8');
  const lonSet = [];
  const latSet = [];
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  let rows = 0, valid = 0;
  let depthMin = Infinity, depthMax = -Infinity;

  // First pass: bounds and spacing, without holding a parsed object per row.
  const lines = text.split('\n');
  const parsed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    const a = line.indexOf(',');
    const b = line.indexOf(',', a + 1);
    if (a < 0 || b < 0) continue;
    const lon = Number(line.slice(0, a));
    const lat = Number(line.slice(a + 1, b));
    const dRaw = line.slice(b + 1);
    const d = dRaw.charCodeAt(0) === 78 /* N of NaN */ ? null : -Number(dRaw); // flip to positive-down
    rows += 1;
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
    if (d !== null && Number.isFinite(d)) {
      valid += 1;
      if (d < depthMin) depthMin = d;
      if (d > depthMax) depthMax = d;
      parsed.push(lon, lat, d);
    } else {
      parsed.push(lon, lat, NaN);
    }
  }

  // Most Slab2 grids are 0.05 degrees, but not all of them: Hindu Kush ships at 0.02. The
  // step is therefore measured from the file (rows are row-major, so longitude varies
  // fastest and the first longitude step is the grid step) and then checked against the row
  // count, so a wrong guess fails loudly instead of producing a sheared surface.
  let STEP = 0;
  for (let k = 3; k < parsed.length; k += 3) {
    const d = Math.abs(parsed[k] - parsed[k - 3]);
    if (d > 1e-9) { STEP = d; break; }
  }
  STEP = Math.round(STEP * 1000) / 1000;
  if (!(STEP > 0)) throw new Error('Could not determine grid step for ' + path);
  const nx = Math.round((lonMax - lonMin) / STEP) + 1;
  const ny = Math.round((latMax - latMin) / STEP) + 1;
  if (nx * ny !== rows) {
    throw new Error('Grid at step ' + STEP + ' is ' + nx + ' x ' + ny + ' = ' + (nx * ny)
      + ' but the file has ' + rows + ' rows: ' + path);
  }

  const depths = new Float32Array(nx * ny);
  depths.fill(NaN);
  for (let k = 0; k < parsed.length; k += 3) {
    const lon = parsed[k], lat = parsed[k + 1], d = parsed[k + 2];
    const ix = Math.round((lon - lonMin) / STEP);
    const iy = Math.round((lat - latMin) / STEP);
    depths[iy * nx + ix] = d;
  }

  return {
    lonMin, lonMax, latMin, latMax, step: STEP, nx, ny, rows, valid,
    depthMinKm: depthMin === Infinity ? null : depthMin,
    depthMaxKm: depthMax === -Infinity ? null : depthMax,
    depths,
  };
}

// Bilinear sample of a grid at an arbitrary lon/lat. Returns null if any of the four
// surrounding nodes is outside the model, so a slab edge never gets extrapolated.
export function sampleGrid(grid, lon, lat) {
  const fx = (lon - grid.lonMin) / grid.step;
  const fy = (lat - grid.latMin) / grid.step;
  if (fx < 0 || fy < 0 || fx > grid.nx - 1 || fy > grid.ny - 1) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid.nx - 1), y1 = Math.min(y0 + 1, grid.ny - 1);
  const tx = fx - x0, ty = fy - y0;
  const d00 = grid.depths[y0 * grid.nx + x0];
  const d10 = grid.depths[y0 * grid.nx + x1];
  const d01 = grid.depths[y1 * grid.nx + x0];
  const d11 = grid.depths[y1 * grid.nx + x1];
  if (!(d00 === d00) || !(d10 === d10) || !(d01 === d01) || !(d11 === d11)) return null;
  return (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
}
