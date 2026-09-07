// Shared reader for the ComCat CSV. RFC4180-ish: fields may be quoted and quoted fields
// may contain commas (place names routinely do) and doubled quotes.

import { readFileSync } from 'node:fs';

const COMMA = 0x2c;
const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

// The ComCat depth-quality question: how many events sit at a fixed default depth?
// Locators pin poorly-constrained events to a round number instead of solving for it.
// These are the values that show up as spikes in a global M4.5+ histogram.
export const DEFAULT_DEPTHS = [10, 33, 35];

export function readCatalogue(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const header = splitCsvLine(lines[0]);
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const need = ['time', 'latitude', 'longitude', 'depth', 'mag', 'place', 'type', 'depthError', 'id', 'magType'];
  for (const k of need) if (!(k in idx)) throw new Error('ComCat CSV is missing column: ' + k);

  const events = [];
  let skippedIncomplete = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    const f = splitCsvLine(line);
    const lat = Number(f[idx.latitude]);
    const lon = Number(f[idx.longitude]);
    const depth = Number(f[idx.depth]);
    const mag = Number(f[idx.mag]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(depth) || !Number.isFinite(mag)) {
      skippedIncomplete += 1;
      continue;
    }
    const de = f[idx.depthError];
    events.push({
      time: f[idx.time],
      lat, lon, depth, mag,
      place: f[idx.place],
      type: f[idx.type],
      depthError: de === '' ? null : Number(de),
      id: f[idx.id],
      magType: f[idx.magType],
    });
  }
  return { events, skippedIncomplete, header, totalLines: lines.filter((l) => l.length > 0).length - 1 };
}

export { COMMA, QUOTE, LF, CR };
