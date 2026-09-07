// The cross-section tool. Two points on the globe define a great circle; every event within
// a corridor of that plane is projected onto it and drawn as a depth section, with the Slab2
// surfaces sampled along the same line. This is the view a seismology textbook uses, and it
// is the one place the page draws its own axes, so the axes are labelled in real units.

import { depthColorHex } from './ramp.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
export const EARTH_RADIUS_KM = 6371;

function toVec(lonDeg, latDeg) {
  const la = latDeg * D2R;
  const lo = lonDeg * D2R;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Great-circle interpolation, used both for the on-globe line and for sampling Slab2.
export function slerpGeo(a, b, t) {
  const va = toVec(a[0], a[1]);
  const vb = toVec(b[0], b[1]);
  const om = Math.acos(Math.max(-1, Math.min(1, dot(va, vb))));
  if (om < 1e-9) return a.slice();
  const s = Math.sin(om);
  const k1 = Math.sin((1 - t) * om) / s;
  const k2 = Math.sin(t * om) / s;
  const v = [va[0] * k1 + vb[0] * k2, va[1] * k1 + vb[1] * k2, va[2] * k1 + vb[2] * k2];
  return [Math.atan2(v[1], v[0]) * R2D, Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D];
}

export function greatCircleKm(a, b) {
  const va = toVec(a[0], a[1]);
  const vb = toVec(b[0], b[1]);
  return Math.acos(Math.max(-1, Math.min(1, dot(va, vb)))) * EARTH_RADIUS_KM;
}

// Collects events near the section plane. `corridorKm` is the half-width perpendicular to
// the plane; it is reported on the panel, because a section is only honest if the reader
// knows how thick a slice they are looking at.
export function collectSection(events, a, b, corridorKm, filters) {
  const va = toVec(a[0], a[1]);
  const vb = toVec(b[0], b[1]);
  const pole = norm(cross(va, vb));
  const totalKm = greatCircleKm(a, b);
  const om = totalKm / EARTH_RADIUS_KM;
  const out = [];
  if (!(om > 1e-6)) return { points: [], totalKm: 0, corridorKm };

  for (let i = 0; i < events.count; i += 1) {
    const d = events.depth[i];
    if (d < filters.depthMin || d > filters.depthMax) continue;
    if (events.mag[i] < filters.magMin) continue;
    const m = events.month[i];
    if (m < filters.monthMin || m > filters.monthMax) continue;
    if (!filters.showAssigned && (events.flags[i] & 1)) continue;

    const v = toVec(events.lon[i], events.lat[i]);
    const offKm = Math.asin(Math.max(-1, Math.min(1, dot(v, pole)))) * EARTH_RADIUS_KM;
    if (Math.abs(offKm) > corridorKm) continue;

    // Distance along the section from `a`, allowing a little overshoot at each end so the
    // section does not clip events sitting just past the drawn line.
    const alongOm = Math.atan2(dot(v, norm(cross(pole, va))), dot(v, va));
    const t = alongOm / om;
    if (t < -0.08 || t > 1.08) continue;
    out.push({ index: i, km: t * totalKm, depth: d, mag: events.mag[i], off: offKm, assigned: !!(events.flags[i] & 1) });
  }
  return { points: out, totalKm, corridorKm };
}

// Samples every slab surface along the section line, returning one polyline per zone that
// actually intersects it.
export function sampleSlabsAlong(zones, a, b, samples) {
  const lines = [];
  for (const z of zones) {
    const pts = [];
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const [lon, lat] = slerpGeo(a, b, t);
      const d = sampleZone(z, lon, lat);
      pts.push(d === null ? null : { t, depth: d });
    }
    if (pts.some((p) => p !== null)) lines.push({ code: z.code, name: z.name, pts });
  }
  return lines;
}

function sampleZone(z, lon, lat) {
  const candidates = [lon, lon < 0 ? lon + 360 : lon - 360];
  for (const L of candidates) {
    const fx = (L - z.lonMin) / z.step;
    const fy = (lat - z.latMin) / z.step;
    if (fx < 0 || fy < 0 || fx > z.nx - 1 || fy > z.ny - 1) continue;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, z.nx - 1), y1 = Math.min(y0 + 1, z.ny - 1);
    const tx = fx - x0, ty = fy - y0;
    const g = z.depths;
    const d00 = g[y0 * z.nx + x0], d10 = g[y0 * z.nx + x1];
    const d01 = g[y1 * z.nx + x0], d11 = g[y1 * z.nx + x1];
    if (d00 === -32768 || d10 === -32768 || d01 === -32768 || d11 === -32768) continue;
    return ((d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty) / 10;
  }
  return null;
}

export function drawSection(canvas, section, slabLines, opts) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 210;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 40, padR = 8, padT = 10, padB = 22;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;
  const maxDepth = opts.maxDepth;
  const totalKm = Math.max(1, section.totalKm);

  const X = (km) => padL + (km / totalKm) * w;
  const Y = (d) => padT + (Math.max(0, d) / maxDepth) * h;

  ctx.strokeStyle = opts.hairline;
  ctx.fillStyle = opts.faint;
  ctx.lineWidth = 1;
  ctx.font = '10px ' + opts.monoFont;
  ctx.textBaseline = 'middle';

  // Depth axis
  const step = maxDepth > 500 ? 200 : maxDepth > 200 ? 100 : 50;
  for (let d = 0; d <= maxDepth; d += step) {
    const y = Math.round(Y(d)) + 0.5;
    ctx.globalAlpha = d === 0 ? 0.6 : 0.28;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'right';
    ctx.fillText(String(d), padL - 6, y);
  }
  ctx.globalAlpha = 0.85;
  ctx.textAlign = 'left';
  ctx.fillText('km depth', 2, padT - 4 < 6 ? 6 : padT - 4);

  // Distance axis
  ctx.textAlign = 'center';
  const kmStep = totalKm > 2000 ? 500 : totalKm > 800 ? 200 : 100;
  for (let k = 0; k <= totalKm; k += kmStep) {
    const x = Math.round(X(k)) + 0.5;
    ctx.globalAlpha = 0.18;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.fillText(String(Math.round(k)), x, cssH - 10);
  }

  // Slab surfaces first, so hypocentres sit on top of them.
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.6;
  for (const line of slabLines) {
    ctx.strokeStyle = opts.slabStroke;
    ctx.beginPath();
    let pen = false;
    for (const p of line.pts) {
      if (p === null) { pen = false; continue; }
      const x = X(p.t * totalKm);
      const y = Y(p.depth);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Hypocentres
  for (const p of section.points) {
    const x = X(p.km);
    const y = Y(p.depth);
    if (y > padT + h + 4) continue;
    const r = 0.9 + (p.mag - 4.5) * 0.55;
    ctx.globalAlpha = p.assigned ? 0.30 : 0.85;
    ctx.fillStyle = p.assigned ? opts.assignedColor : depthColorHex(p.depth, opts.ramp);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // A depth section that stretches its vertical axis without saying so is a lie about dip.
  // Return the exaggeration so the caller can print it.
  const kmPerPxX = totalKm / w;
  const kmPerPxY = maxDepth / h;
  return { verticalExaggeration: kmPerPxX / kmPerPxY, plotWidth: w, plotHeight: h };
}
