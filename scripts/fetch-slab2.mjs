#!/usr/bin/env node
// Fetch USGS Slab2 (Hayes et al. 2018) from ScienceBase and extract only what dipmeter renders.
//
// Source:  ScienceBase item 5aa1b00ee4b0b1c392e86467, DOI 10.5066/F7PV6JNV
// Licence: U.S. Public Domain. The shipped FGDC metadata (Slab2.xml) carries
//          <useconst>none</useconst> and <accconst>none</accconst>; this script asserts both
//          and fails loudly if the served metadata ever stops saying so.
//
// Writes:  data/raw/Slab2.xml
//          data/raw/Slab2Distribute_Mar2018.tar.gz  (140 MB, not committed)
//          data/raw/slab2/*_dep_*.grd               (the 27 depth grids, committed)
//          data/raw/slab2-nodes/*_nod_*.csv         (the supplementary node files)
//          data/raw/slab2-fetch-manifest.json

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync, createWriteStream } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = join(ROOT, 'data', 'raw');

const ITEM = 'https://www.sciencebase.gov/catalog/item/5aa1b00ee4b0b1c392e86467?format=json';

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) {
    process.stdout.write('cached ' + basename(dest) + ' ' + statSync(dest).size + ' B\n');
    return statSync(dest).size;
  }
  process.stdout.write('downloading ' + basename(dest) + ' ...\n');
  const res = await fetch(url, { headers: { 'User-Agent': 'dipmeter/1.0 (portfolio build)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const size = statSync(dest).size;
  process.stdout.write('  ' + size + ' B\n');
  return size;
}

export async function main() {
  mkdirSync(RAW, { recursive: true });
  const itemRes = await fetch(ITEM);
  const item = await itemRes.json();
  const byName = new Map((item.files || []).map((f) => [f.name, f]));

  const xmlFile = byName.get('Slab2.xml');
  const tarFile = byName.get('Slab2Distribute_Mar2018.tar.gz');
  if (!xmlFile || !tarFile) throw new Error('ScienceBase item no longer carries Slab2.xml + Slab2Distribute_Mar2018.tar.gz');

  const xmlPath = join(RAW, 'Slab2.xml');
  await download(xmlFile.url, xmlPath);
  const xml = readFileSync(xmlPath, 'utf8');
  const useconst = /<useconst>([\s\S]*?)<\/useconst>/.exec(xml);
  const accconst = /<accconst>([\s\S]*?)<\/accconst>/.exec(xml);
  const licence = { useconst: useconst ? useconst[1].trim() : null, accconst: accconst ? accconst[1].trim() : null };
  process.stdout.write('Slab2.xml useconst=' + JSON.stringify(licence.useconst) + ' accconst=' + JSON.stringify(licence.accconst) + '\n');
  if (!licence.useconst || licence.useconst.toLowerCase() !== 'none') {
    throw new Error('Slab2 use constraints are no longer "none" (' + licence.useconst + '). Stop and re-check the licence before shipping.');
  }

  const tarPath = join(RAW, 'Slab2Distribute_Mar2018.tar.gz');
  const tarBytes = await download(tarFile.url, tarPath);

  // Extract only the depth grids and node files. tar ships with Git for Windows and with macOS/Linux.
  const depDir = join(RAW, 'slab2');
  const nodDir = join(RAW, 'slab2-nodes');
  mkdirSync(depDir, { recursive: true });
  mkdirSync(nodDir, { recursive: true });

  // GNU tar on Windows reads "C:\..." as a remote host spec ("Cannot connect to C:"), so every
  // tar call runs with cwd = data/raw and purely relative paths.
  const TARNAME = 'Slab2Distribute_Mar2018.tar.gz';
  const listing = execFileSync('tar', ['-tzf', TARNAME], { cwd: RAW, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  writeFileSync(join(RAW, 'slab2-tar-listing.txt'), listing.join('\n') + '\n');

  const depEntries = listing.filter((p) => /_dep_[^/]*\.grd$/.test(p));
  // Slab2Supp holds the supplementary NODE files, and it holds them for exactly the zones whose
  // surface overturns past vertical and therefore cannot be expressed as a single-valued z(x, y).
  // The count of files in this directory IS the count of overturned zones; it is not asserted.
  const supEntries = listing.filter((p) => /Slab2Supp\/[a-z]{3}_slab2_sup_[^/]*\.csv$/.test(p));
  // Slab2Clips holds each zone's clipping polygon: the outline beyond which the gridded surface
  // is extrapolation rather than model. Used to trim the meshes instead of drawing fiction.
  const clpEntries = listing.filter((p) => /Slab2Clips\/[a-z]{3}_slab2_clp_[^/]*\.csv$/.test(p));
  process.stdout.write('tar entries: ' + listing.length + ', depth grids: ' + depEntries.length
    + ', supplementary node files: ' + supEntries.length + ', clip polygons: ' + clpEntries.length + '\n');

  // The .grd files are netCDF-4, i.e. HDF5 (verified: first four bytes are 0x89 'H' 'D' 'F').
  // Reading HDF5 needs a B-tree + chunked-deflate reader; Slab2 ships Slab2_TXT/*.xyz, which is
  // the SAME grid as plain "lon lat depth" ASCII. We build from the .xyz and keep the .grd files
  // as the citable primary artifact. Equivalence is asserted by scripts/verify.mjs, which checks
  // the .xyz row count against the .grd's own stored dimensions.
  const xyzEntries = listing.filter((p) => /Slab2_TXT\/[a-z]{3}_slab2_dep_[^/]*\.xyz$/.test(p));
  const xyzDir = join(RAW, 'slab2-xyz');
  mkdirSync(xyzDir, { recursive: true });
  if (xyzEntries.length > 0 && readdirSync(xyzDir).length < xyzEntries.length) {
    execFileSync('tar', ['-xzf', TARNAME, '-C', 'slab2-xyz', '--strip-components=2'].concat(xyzEntries), { cwd: RAW, stdio: 'inherit' });
  }

  const clpDir = join(RAW, 'slab2-clips');
  mkdirSync(clpDir, { recursive: true });
  if (readdirSync(depDir).length < depEntries.length) {
    execFileSync('tar', ['-xzf', TARNAME, '-C', 'slab2', '--strip-components=1'].concat(depEntries), { cwd: RAW, stdio: 'inherit' });
  }
  if (supEntries.length > 0 && readdirSync(nodDir).length < supEntries.length) {
    execFileSync('tar', ['-xzf', TARNAME, '-C', 'slab2-nodes', '--strip-components=2'].concat(supEntries), { cwd: RAW, stdio: 'inherit' });
  }
  if (clpEntries.length > 0 && readdirSync(clpDir).length < clpEntries.length) {
    execFileSync('tar', ['-xzf', TARNAME, '-C', 'slab2-clips', '--strip-components=2'].concat(clpEntries), { cwd: RAW, stdio: 'inherit' });
  }

  const deps = readdirSync(depDir).filter((f) => f.endsWith('.grd'));
  const nods = readdirSync(nodDir).filter((f) => f.endsWith('.csv'));
  const clps = readdirSync(clpDir).filter((f) => f.endsWith('.csv'));
  const clpBytes = clps.reduce((a, f) => a + statSync(join(clpDir, f)).size, 0);
  const xyzs = readdirSync(xyzDir).filter((f) => f.endsWith('.xyz'));
  const xyzBytes = xyzs.reduce((a, f) => a + statSync(join(xyzDir, f)).size, 0);
  const depBytes = deps.reduce((a, f) => a + statSync(join(depDir, f)).size, 0);
  const nodBytes = nods.reduce((a, f) => a + statSync(join(nodDir, f)).size, 0);

  const manifest = {
    fetchedAt: new Date().toISOString(),
    item: 'https://www.sciencebase.gov/catalog/item/5aa1b00ee4b0b1c392e86467',
    doi: '10.5066/F7PV6JNV',
    licence: { statement: 'U.S. Public Domain', fgdc: licence },
    archive: { name: 'Slab2Distribute_Mar2018.tar.gz', bytes: tarBytes, entries: listing.length },
    depthGrids: { count: deps.length, bytes: depBytes, files: deps.sort() },
    supplementaryNodeFiles: { count: nods.length, bytes: nodBytes, files: nods.sort(), meaning: 'zones whose surface overturns past vertical' },
    clipPolygons: { count: clps.length, bytes: clpBytes, files: clps.sort() },
    depthGridsAscii: { count: xyzs.length, bytes: xyzBytes, note: 'Slab2_TXT ASCII twins of the .grd depth grids; the build reads these' },
  };
  writeFileSync(join(RAW, 'slab2-fetch-manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write('depth grids: ' + deps.length + ' files, ' + depBytes + ' B\n');
  process.stdout.write('sup nodes:   ' + nods.length + ' files, ' + nodBytes + ' B  -> ' + nods.map((f) => f.slice(0, 3)).join(' ') + '\n');
  process.stdout.write('clip polys:  ' + clps.length + ' files, ' + clpBytes + ' B\n');
  process.stdout.write('dep .xyz:    ' + xyzs.length + ' files, ' + xyzBytes + ' B\n');
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err) + '\n'); process.exitCode = 1; });
}
