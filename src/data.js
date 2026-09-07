// Readers for the three binaries written by scripts/build-data.mjs. The decode constants are
// not duplicated here: they are read from manifest.json, so a change to the packer can never
// silently desynchronise from the page.

export const FLAG_DEFAULT_DEPTH = 1;
export const FLAG_NOT_EARTHQUAKE = 2;

const MAGIC_EVENTS = 0x45504944;
const MAGIC_SLABS = 0x53504944;
const MAGIC_COAST = 0x43504944;

function checkMagic(view, expected, label) {
  const got = view.getUint32(0, true);
  if (got !== expected) {
    throw new Error(label + ' has magic 0x' + got.toString(16) + ', expected 0x' + expected.toString(16));
  }
  return view.getUint32(8, true);
}

export async function loadManifest(base) {
  const res = await fetch(base + 'manifest.json');
  if (!res.ok) throw new Error('manifest.json: HTTP ' + res.status);
  return res.json();
}

export async function loadEvents(base, file, enc) {
  const res = await fetch(base + file);
  if (!res.ok) throw new Error(file + ': HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const n = checkMagic(view, MAGIC_EVENTS, file);

  let o = 16;
  const lat = new Int16Array(buf, o, n); o += n * 2;
  const lon = new Int16Array(buf, o, n); o += n * 2;
  const depth = new Uint16Array(buf, o, n); o += n * 2;
  const month = new Uint16Array(buf, o, n); o += n * 2;
  const region = new Uint16Array(buf, o, n); o += n * 2;
  const mag = new Uint8Array(buf, o, n); o += n;
  const flags = new Uint8Array(buf, o, n); o += n;
  const zone = new Uint8Array(buf, o, n); o += n;
  if (o !== buf.byteLength) {
    throw new Error(file + ' is ' + buf.byteLength + ' bytes but the header describes ' + o);
  }

  // Decoded views, built once. Float32 is exact enough for every quantity here: the encoder
  // already threw away more precision than a float32 mantissa ever will.
  const latF = new Float32Array(n);
  const lonF = new Float32Array(n);
  const depthF = new Float32Array(n);
  const magF = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    latF[i] = lat[i] / enc.LAT_SCALE;
    lonF[i] = lon[i] / enc.LON_SCALE;
    depthF[i] = depth[i] / enc.DEPTH_SCALE - enc.DEPTH_OFFSET;
    magF[i] = (mag[i] + enc.MAG_TENTHS_OFFSET) / 10;
  }
  return { count: n, lat: latF, lon: lonF, depth: depthF, mag: magF, month, region, flags, zone, bytes: buf.byteLength };
}

export async function loadSlabs(base, manifest) {
  const res = await fetch(base + 'slabs.bin');
  if (!res.ok) throw new Error('slabs.bin: HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const n = checkMagic(view, MAGIC_SLABS, 'slabs.bin');
  if (n !== manifest.zones.length) {
    throw new Error('slabs.bin declares ' + n + ' zones, manifest lists ' + manifest.zones.length);
  }
  return manifest.zones.map((z) => ({
    ...z,
    depths: new Int16Array(buf, z.byteOffset, z.nx * z.ny),
  }));
}

export async function loadCoast(base, enc) {
  const res = await fetch(base + 'coast.bin');
  if (!res.ok) throw new Error('coast.bin: HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const strands = checkMagic(view, MAGIC_COAST, 'coast.bin');
  const points = view.getUint32(12, true);
  const lengths = new Uint32Array(buf, 16, strands);
  const coords = new Int16Array(buf, 16 + strands * 4, points * 2);
  const lines = [];
  let k = 0;
  for (let i = 0; i < strands; i += 1) {
    const len = lengths[i];
    const pts = new Float32Array(len * 2);
    for (let j = 0; j < len; j += 1) {
      pts[j * 2] = coords[k++] / enc.COAST_SCALE;
      pts[j * 2 + 1] = coords[k++] / enc.COAST_SCALE;
    }
    lines.push(pts);
  }
  return { strands, points, lines };
}

// Merges two event tiers into one set of contiguous typed arrays, so the renderer holds a
// single geometry rather than two.
export function concatEvents(a, b) {
  const n = a.count + b.count;
  const out = {
    count: n,
    lat: new Float32Array(n), lon: new Float32Array(n), depth: new Float32Array(n),
    mag: new Float32Array(n), month: new Uint16Array(n), region: new Uint16Array(n),
    flags: new Uint8Array(n), zone: new Uint8Array(n),
    bytes: a.bytes + b.bytes,
  };
  for (const k of ['lat', 'lon', 'depth', 'mag', 'month', 'region', 'flags', 'zone']) {
    out[k].set(a[k], 0);
    out[k].set(b[k], a.count);
  }
  return out;
}

export const NODATA = -32768;
