#!/usr/bin/env node
// Fetch the USGS ANSS ComCat catalogue, M4.5+, 1990-01-01 to the run date,
// in yearly chunks because the FDSN event service caps a single query at 20,000 rows.
//
// Source:  https://earthquake.usgs.gov/fdsnws/event/1/query
// Licence: U.S. Public Domain (USGS). https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
//
// Writes:  data/raw/comcat/comcat-<year>.csv   (one file per year, resumable)
//          data/raw/comcat-m45-1990-2026.csv   (concatenated, one header)
//          data/raw/comcat-fetch-manifest.json (per-chunk byte counts and row counts)

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = join(ROOT, 'data', 'raw');
const CHUNKS = join(RAW, 'comcat');

const START_YEAR = 1990;
const END_YEAR = 2026;
const MIN_MAG = 4.5;
const BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

function chunkUrl(year) {
  const params = new URLSearchParams({
    format: 'csv',
    starttime: year + '-01-01T00:00:00',
    endtime: (year + 1) + '-01-01T00:00:00',
    minmagnitude: String(MIN_MAG),
    orderby: 'time-asc',
  });
  // Deliberately NO eventtype filter. The service would happily drop quarry blasts and
  // explosions for us, but then the headline count could not be compared with anyone else's
  // query and the exclusion would be invisible. We take everything the catalogue returns and
  // classify on the CSV's own `type` column at pack time, so the exclusion is a printed number.
  return BASE + '?' + params.toString();
}

async function fetchWithRetry(url, attempts = 5) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'dipmeter/1.0 (portfolio build; contact via github.com/jamessuuu)' } });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const wait = 2000 * (i + 1);
      process.stderr.write('  retry ' + (i + 1) + '/' + attempts + ' after ' + wait + 'ms (' + err.message + ')\n');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function main() {
  mkdirSync(CHUNKS, { recursive: true });
  const manifest = { fetchedAt: new Date().toISOString(), source: BASE, licence: 'U.S. Public Domain (USGS)', minMagnitude: MIN_MAG, chunks: [] };

  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    const out = join(CHUNKS, 'comcat-' + year + '.csv');
    let text;
    if (existsSync(out) && statSync(out).size > 200) {
      text = readFileSync(out, 'utf8');
      process.stdout.write(year + ' cached  ' + statSync(out).size + ' B\n');
    } else {
      process.stdout.write(year + ' fetching...');
      text = await fetchWithRetry(chunkUrl(year));
      writeFileSync(out, text);
      process.stdout.write(' ' + Buffer.byteLength(text) + ' B\n');
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    const rows = Math.max(0, lines.length - 1);
    if (rows >= 20000) {
      process.stderr.write('WARNING: ' + year + ' returned ' + rows + ' rows, at or over the 20,000 service cap. Chunk smaller.\n');
    }
    manifest.chunks.push({ year, bytes: Buffer.byteLength(text), rows });
  }

  // Concatenate: header from the first chunk, data rows from all.
  const combined = join(RAW, 'comcat-m45-1990-2026.csv');
  const ws = createWriteStream(combined);
  let header = null;
  let total = 0;
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    const text = readFileSync(join(CHUNKS, 'comcat-' + year + '.csv'), 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (header === null) {
      header = lines[0];
      ws.write(header + '\n');
    } else if (lines[0] !== header) {
      throw new Error('Header drift in ' + year + '. Refusing to concatenate mismatched CSV.');
    }
    for (let i = 1; i < lines.length; i += 1) {
      ws.write(lines[i] + '\n');
      total += 1;
    }
  }
  await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject); });

  manifest.combined = { path: 'data/raw/comcat-m45-1990-2026.csv', bytes: statSync(combined).size, rows: total };
  writeFileSync(join(RAW, 'comcat-fetch-manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write('\nCombined: ' + total + ' rows, ' + statSync(combined).size + ' B\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
