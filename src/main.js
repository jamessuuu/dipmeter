import './styles.css';
import { loadManifest, loadEvents, loadSlabs, loadCoast, concatEvents } from './data.js';
import { readDepthRamp, readColor, depthColorHex } from './ramp.js';
import {
  createScene, buildEarthShell, buildCoastlines, buildPoints, buildSlabs, buildSectionLine,
  geoToVec, Vector3, EARTH_RADIUS_KM, TRANSITION_ZONE_KM,
} from './globe.js';
import { collectSection, sampleSlabsAlong, drawSection, greatCircleKm, slerpGeo } from './section.js';

const BASE = import.meta.env.BASE_URL + 'data/';
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  depthMin: 0, depthMax: 800,
  magMin: 4.5,
  monthMin: 0, monthMax: 9999,
  showAssigned: true,
  showSlabs: true,
  showCoast: true,
  exag: 1,
  zone: 0,
  sectionMode: false,
  sectionA: null, sectionB: null,
  corridorKm: 150,
};

let manifest = null;
let events = null;
let zones = null;
let scene = null;
let points = null;
let slabMesh = null;
let sectionLine = null;
let ramp = null;
let assignedColor = null;
let needsRender = true;

function setProgress(t, label) {
  const bar = document.querySelector('#loading .bar i');
  if (bar) bar.style.transform = 'scaleX(' + t + ')';
  const l = document.querySelector('#loading .label');
  if (l && label) l.textContent = label;
}

// ---------------------------------------------------------------------------------------

async function boot() {
  const canvas = $('gl');
  if (!canvas) return;

  let gl = null;
  try { gl = canvas.getContext('webgl2'); } catch { gl = null; }
  if (!gl) {
    // No WebGL2. The decimated SVG and the complete tables are already in the served HTML,
    // so there is nothing to inject and nothing to apologise for. Just make them visible.
    document.body.classList.add('no-webgl');
    $('loading').hidden = true;
    const note = $('fallback-reason');
    if (note) {
      note.hidden = false;
      note.textContent = 'This browser did not provide a WebGL2 context, so the interactive globe is not running. Everything below is the full dataset in table form.';
    }
    return;
  }

  setProgress(0.05, 'Reading manifest');
  manifest = await loadManifest(BASE);
  const enc = manifest.encoding;

  paintHeadline();

  setProgress(0.2, 'Loading M5.0 and above');
  const tierA = await loadEvents(BASE, 'events-a.bin', enc);
  setProgress(0.45, 'Loading slab surfaces');
  const [slabZones, coast] = await Promise.all([loadSlabs(BASE, manifest), loadCoast(BASE, enc)]);
  zones = slabZones;

  ramp = readDepthRamp();
  assignedColor = readColor('--assigned', [0.62, 0.02, 255]);
  const shellColor = readColor('--hairline-strong', [0.46, 0.02, 255]);
  const referenceColor = readColor('--reference', [0.52, 0.02, 255]);

  setProgress(0.6, 'Building the scene');
  scene = createScene(canvas, { reducedMotion });
  scene.controls.addEventListener('change', () => { needsRender = true; });

  scene.root.add(buildEarthShell({ shell: shellColor, transition: referenceColor }));
  const coastBuilt = buildCoastlines(coast, shellColor);
  scene.root.add(coastBuilt.mesh);

  events = tierA;
  points = buildPoints(events, ramp, assignedColor, reducedMotion, isAdditive());
  scene.root.add(points);

  const slabs = buildSlabs(zones, ramp);
  slabMesh = slabs.mesh;
  scene.root.add(slabMesh);

  sectionLine = buildSectionLine(readColor('--accent', [0.78, 0.15, 68]));
  scene.root.add(sectionLine);

  document.body.classList.add('has-webgl');
  resize();
  window.addEventListener('resize', resize);
  frameZone('ker', true);
  buildUI(coastBuilt.segments, slabs);
  applyFilters();
  animate();

  setProgress(0.75, 'Loading M4.5 to M4.9');
  const tierB = await loadEvents(BASE, 'events-b.bin', enc);
  events = concatEvents(tierA, tierB);
  scene.root.remove(points);
  points.geometry.dispose();
  points.material.dispose();
  points = buildPoints(events, ramp, assignedColor, reducedMotion, isAdditive());
  scene.root.add(points);
  applyFilters();

  setProgress(1, 'Ready');
  const loading = $('loading');
  loading.style.opacity = '0';
  window.setTimeout(() => { loading.hidden = true; }, reducedMotion ? 0 : 420);

  // Anything downstream reads these; exposed for the screenshot harness and for anyone who
  // wants to check the page's arithmetic in a console rather than trusting the caption.
  window.__dipmeter = {
    manifest,
    counts: () => visibleCount(),
    triangles: slabs.triangles,
    slabVertices: slabs.vertices,
    coastSegments: coastBuilt.segments,
    events: () => events.count,
    state,
  };
  document.documentElement.dataset.ready = 'true';
}

function isAdditive() {
  return document.documentElement.dataset.theme !== 'daylight';
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  scene.renderer.setSize(w, h, false);
  scene.camera.aspect = w / h;
  scene.camera.updateProjectionMatrix();
  needsRender = true;
}

function animate() {
  requestAnimationFrame(animate);
  const moved = scene.controls.update();
  if (moved || needsRender) {
    scene.renderer.render(scene.scene, scene.camera);
    needsRender = false;
  }
}

// ---- Headline and readout --------------------------------------------------------------

function paintHeadline() {
  const c = manifest.counts;
  // Every number in this block is read from manifest.json, which is generated from the files
  // on disk. None of it is typed. If the catalogue changes, re-running the build changes the
  // page; there is no second place to update.
  $('headline').innerHTML = '<b>' + fmt(c.events) + '</b> located hypocentres<br>against <b>'
    + fmt(manifest.zones.length) + '</b> modelled slabs';
  $('headline-sub').textContent =
    'USGS ComCat, magnitude ' + manifest.counts.magnitude.min + ' and above, '
    + manifest.counts.months.firstEvent.slice(0, 4) + ' to ' + manifest.counts.months.lastEvent.slice(0, 4)
    + '. Depths ' + c.depthKm.min + ' to ' + c.depthKm.max + ' km, drawn at true scale inside the Earth.';
}

function visibleCount() {
  let n = 0;
  for (let i = 0; i < events.count; i += 1) {
    const d = events.depth[i];
    if (d < state.depthMin || d > state.depthMax) continue;
    if (events.mag[i] < state.magMin) continue;
    const m = events.month[i];
    if (m < state.monthMin || m > state.monthMax) continue;
    if (!state.showAssigned && (events.flags[i] & 1)) continue;
    if (state.zone && events.zone[i] !== state.zone) continue;
    n += 1;
  }
  return n;
}

let countTimer = 0;
function scheduleCount() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(() => {
    const n = visibleCount();
    $('visible-count').textContent = fmt(n);
    $('visible-share').textContent = (100 * n / events.count).toFixed(1) + '% of ' + fmt(events.count);
  }, 90);
}

function applyFilters() {
  const u = points.material.uniforms;
  u.uDepthRange.value = [state.depthMin, state.depthMax];
  u.uMagMin.value = state.magMin;
  u.uMonthRange.value = [state.monthMin, state.monthMax];
  u.uShowAssigned.value = state.showAssigned ? 1 : 0;
  u.uZoneFilter.value = state.zone;
  u.uExag.value = state.exag;
  slabMesh.material.uniforms.uExag.value = state.exag;
  slabMesh.material.uniforms.uZoneFilter.value = state.zone;
  slabMesh.visible = state.showSlabs;
  const coastMesh = scene.root.getObjectByName('coastlines');
  if (coastMesh) coastMesh.visible = state.showCoast;
  needsRender = true;
  scheduleCount();
  if (state.sectionA && state.sectionB) redrawSection();
}

// ---- Camera ------------------------------------------------------------------------------

const HALF_FOV = Math.tan((38 / 2) * Math.PI / 180);

function frameZone(code, instant) {
  const z = manifest.zones.find((x) => x.code === code);
  if (!z) return;
  const lon = z.lonMin + (z.nx * z.step) / 2;
  const lat = z.latMin + (z.ny * z.step) / 2;
  const spanDeg = Math.max(z.nx * z.step, z.ny * z.step);
  // Distance that actually fits the zone's arc in the frame, rather than a fudge factor:
  // the arc subtends spanDeg of great circle, so half of it must fit inside tan(fov/2).
  const arc = (spanDeg * Math.PI) / 180;
  // 1.3 is headroom, not a fudge: an arc that exactly fills the frame is an arc that touches
  // both edges, and the aspect ratio is narrower vertically than horizontally on a phone.
  const distance = Math.max(0.38, Math.min(2.6, ((arc / 2) / HALF_FOV) * 1.3));
  flyTo(lon, lat, distance, instant, 'zone');
}

function frameGlobal(instant) {
  flyTo(150, -18, 3.5, instant, 'global');
}

// Places the camera obliquely, looking along the strike of the arc rather than down onto it.
// A map already shows the plan view; the whole subject of this page is what a plan view
// destroys, so the default must never be a top-down shot.
function cameraFor(lon, lat, distance, mode) {
  const n = geoToVec(lon, lat, 0, 1, new Vector3()).normalize();
  const worldUp = new Vector3(0, 1, 0);
  const east = new Vector3().crossVectors(worldUp, n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new Vector3().crossVectors(n, east).normalize();

  if (mode === 'global') {
    return { target: new Vector3(0, 0, 0), position: n.clone().multiplyScalar(distance * 0.92).addScaledVector(worldUp, distance * 0.38) };
  }
  // Target sits a little inside the surface so the slab volume, not the crust, is centred.
  const target = n.clone().multiplyScalar(0.94);
  // How oblique the view is has to depend on how far away it is. A strongly tangential
  // offset at 0.6 radii is the intended look along the strike of an arc; the same offset at
  // 2 radii swings the camera most of a quadrant away and the target stops being the
  // subject. So the tangential weight falls off as the view pulls back.
  const t = Math.max(0, Math.min(1, (distance - 0.5) / 1.3));
  const tangential = 0.82 - 0.52 * t;
  const offset = new Vector3()
    .addScaledVector(n, 0.55 + 0.35 * t)
    .addScaledVector(east, tangential)
    .addScaledVector(north, tangential * 0.33)
    .normalize()
    .multiplyScalar(distance);
  return { target, position: target.clone().add(offset) };
}

function flyTo(lon, lat, distance, instant, mode) {
  const goal = cameraFor(lon, lat, distance, mode || 'zone');
  if (instant || reducedMotion) {
    scene.camera.position.copy(goal.position);
    scene.controls.target.copy(goal.target);
    scene.controls.update();
    needsRender = true;
    return;
  }
  const fromPos = scene.camera.position.clone();
  const fromTarget = scene.controls.target.clone();
  const startedAt = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - startedAt) / 900);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    scene.camera.position.lerpVectors(fromPos, goal.position, e);
    scene.controls.target.lerpVectors(fromTarget, goal.target, e);
    scene.controls.update();
    needsRender = true;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- Picking ------------------------------------------------------------------------------
// Raycasting cannot be used here: the shader decides visibility, so three.js has no idea
// which points are on screen. Projecting the visible set on click is exact and costs one
// pass over the arrays, which is cheap enough for a pointer event.

function pickAt(clientX, clientY) {
  const w = window.innerWidth, h = window.innerHeight;
  const v = new Vector3();
  let best = null;
  const maxPx = 14;
  for (let i = 0; i < events.count; i += 1) {
    const d = events.depth[i];
    if (d < state.depthMin || d > state.depthMax) continue;
    if (events.mag[i] < state.magMin) continue;
    const m = events.month[i];
    if (m < state.monthMin || m > state.monthMax) continue;
    if (!state.showAssigned && (events.flags[i] & 1)) continue;
    if (state.zone && events.zone[i] !== state.zone) continue;

    geoToVec(events.lon[i], events.lat[i], d, state.exag, v);
    v.project(scene.camera);
    if (v.z < -1 || v.z > 1) continue;
    const sx = (v.x * 0.5 + 0.5) * w;
    const sy = (-v.y * 0.5 + 0.5) * h;
    const dx = sx - clientX, dy = sy - clientY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > maxPx * maxPx) continue;
    // Prefer the nearer of two overlapping points, then the closer to the cursor.
    if (!best || v.z < best.ndcZ - 0.0005 || (Math.abs(v.z - best.ndcZ) <= 0.0005 && dist2 < best.dist2)) {
      best = { i, dist2, ndcZ: v.z, sx, sy };
    }
  }
  return best;
}

function showTip(hit, clientX, clientY) {
  const tip = $('tip');
  if (!hit) { tip.hidden = true; return; }
  const i = hit.i;
  const zoneIdx = events.zone[i];
  const zone = zoneIdx ? manifest.zones[zoneIdx - 1] : null;
  const region = manifest.regions[events.region[i]];
  const monthsFrom = events.month[i];
  const year = manifest.counts.months.epochYear + Math.floor(monthsFrom / 12);
  const month = (monthsFrom % 12) + 1;
  const assigned = !!(events.flags[i] & 1);
  tip.innerHTML =
    '<div class="tip-place">' + escapeHtml(region ? region.name : 'Unnamed region') + '</div>'
    + '<dl>'
    + '<dt>Magnitude</dt><dd>' + events.mag[i].toFixed(1) + '</dd>'
    + '<dt>Depth</dt><dd>' + events.depth[i].toFixed(1) + ' km' + (assigned ? ' (assigned)' : '') + '</dd>'
    + '<dt>Date</dt><dd>' + year + '-' + String(month).padStart(2, '0') + '</dd>'
    + '<dt>Position</dt><dd>' + events.lat[i].toFixed(2) + ', ' + events.lon[i].toFixed(2) + '</dd>'
    + '<dt>Slab</dt><dd>' + (zone ? escapeHtml(zone.name) : 'none') + '</dd>'
    + '</dl>';
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, clientX + 14) + 'px';
  tip.style.top = Math.min(window.innerHeight - r.height - 8, clientY + 14) + 'px';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Converts a screen position to a lon/lat on the Earth's surface, for the section tool.
function screenToGeo(clientX, clientY) {
  const w = window.innerWidth, h = window.innerHeight;
  const ndc = new Vector3((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1, 0.5);
  ndc.unproject(scene.camera);
  const origin = scene.camera.position.clone();
  const dir = ndc.sub(origin).normalize();
  // Intersect with the unit sphere.
  const b = 2 * origin.dot(dir);
  const c = origin.dot(origin) - 1;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  if (t < 0) return null;
  const p = origin.add(dir.multiplyScalar(t));
  const lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * 180 / Math.PI;
  const lon = Math.atan2(-p.z, p.x) * 180 / Math.PI;
  return [lon, lat];
}

// ---- Cross section -------------------------------------------------------------------------

function updateSectionLine() {
  if (!state.sectionA || !state.sectionB) { sectionLine.visible = false; needsRender = true; return; }
  const n = 63;
  const pos = sectionLine.geometry.attributes.position.array;
  const v = new Vector3();
  for (let i = 0; i <= n; i += 1) {
    const [lon, lat] = slerpGeo(state.sectionA, state.sectionB, i / n);
    geoToVec(lon, lat, 0, 1, v);
    pos[i * 3] = v.x * 1.002; pos[i * 3 + 1] = v.y * 1.002; pos[i * 3 + 2] = v.z * 1.002;
  }
  sectionLine.geometry.setDrawRange(0, n + 1);
  sectionLine.geometry.attributes.position.needsUpdate = true;
  sectionLine.visible = true;
  needsRender = true;
}

function redrawSection() {
  if (!state.sectionA || !state.sectionB) return;
  const filters = {
    depthMin: state.depthMin, depthMax: state.depthMax, magMin: state.magMin,
    monthMin: state.monthMin, monthMax: state.monthMax, showAssigned: state.showAssigned,
  };
  const sec = collectSection(events, state.sectionA, state.sectionB, state.corridorKm, filters);
  const slabLines = state.showSlabs ? sampleSlabsAlong(zones, state.sectionA, state.sectionB, 180) : [];
  // The depth axis is scaled to what is actually in this section, rounded up to a round
  // number, so a shallow section is not squeezed into the top eighth of the plot.
  let deepest = 0;
  for (const p of sec.points) if (p.depth > deepest) deepest = p.depth;
  for (const l of slabLines) for (const p of l.pts) if (p && p.depth > deepest) deepest = p.depth;
  const axisMax = Math.min(state.depthMax, Math.max(100, Math.ceil((deepest * 1.08) / 50) * 50));
  $('panel-section').hidden = false;
  document.body.classList.add('section-open');
  $('section-count').textContent = fmt(sec.points.length);
  $('section-length').textContent = Math.round(sec.totalKm) + ' km';
  $('section-note').textContent =
    fmt(sec.points.length) + ' events within ' + state.corridorKm + ' km of a '
    + Math.round(sec.totalKm) + ' km section' + (slabLines.length
      ? ', with ' + slabLines.length + ' Slab2 surface' + (slabLines.length === 1 ? '' : 's') + ' crossing it.'
      : '. No Slab2 surface crosses this line.');
  const geom = drawSection($('section-canvas'), sec, slabLines, {
    maxDepth: axisMax,
    ramp,
    hairline: getComputedStyle(document.documentElement).getPropertyValue('--hairline-strong').trim(),
    faint: getComputedStyle(document.documentElement).getPropertyValue('--ink-faint').trim(),
    slabStroke: getComputedStyle(document.documentElement).getPropertyValue('--ink-muted').trim(),
    assignedColor: getComputedStyle(document.documentElement).getPropertyValue('--assigned').trim(),
    monoFont: 'ui-monospace, monospace',
  });
  // vx > 1 means a kilometre of depth is drawn taller than a kilometre of distance, which
  // makes the plane look steeper than it is. vx < 1 compresses it and makes the plane look
  // shallower. Getting this sentence backwards would misrepresent the one measurement the
  // section exists to convey, so both cases are spelled out.
  const vx = geom && geom.verticalExaggeration ? geom.verticalExaggeration : 1;
  const trueScale = vx >= 0.98 && vx <= 1.02;
  $('section-note').textContent += ' Depth axis to ' + axisMax + ' km. '
    + (trueScale
      ? 'Vertical scale is 1:1, so the dip drawn here is the true dip.'
      : 'Vertical scale is ' + vx.toFixed(2) + ' times the horizontal, so the plane is drawn '
        + (vx > 1 ? 'steeper' : 'shallower') + ' than its true dip.');
}

// ---- UI ------------------------------------------------------------------------------------

function buildUI(coastSegments, slabs) {
  const c = manifest.counts;

  const bind = (id, fn) => { const el = $(id); if (el) fn(el); return $(id); };

  // Depth range
  const depthMin = $('f-depth-min');
  const depthMax = $('f-depth-max');
  const depthOut = $('f-depth-out');
  const syncDepth = () => {
    let lo = Number(depthMin.value), hi = Number(depthMax.value);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    state.depthMin = lo; state.depthMax = hi;
    depthOut.textContent = lo + ' to ' + hi + ' km';
    applyFilters();
  };
  depthMin.addEventListener('input', syncDepth);
  depthMax.addEventListener('input', syncDepth);
  depthMax.max = String(Math.ceil(c.depthKm.max / 50) * 50);
  depthMax.value = depthMax.max;
  depthMin.max = depthMax.max;
  syncDepth();

  // Magnitude
  const mag = $('f-mag');
  mag.min = String(c.magnitude.min);
  mag.max = String(Math.floor(c.magnitude.max * 10) / 10);
  mag.value = String(c.magnitude.min);
  mag.addEventListener('input', () => {
    state.magMin = Number(mag.value);
    $('f-mag-out').textContent = 'M' + state.magMin.toFixed(1) + ' and above';
    applyFilters();
  });
  $('f-mag-out').textContent = 'M' + Number(mag.value).toFixed(1) + ' and above';

  // Time
  const months = c.months.count;
  const t0 = $('f-time-min');
  const t1 = $('f-time-max');
  t0.max = String(months - 1); t1.max = String(months - 1);
  t0.value = '0'; t1.value = String(months - 1);
  const label = (m) => (c.months.epochYear + Math.floor(m / 12)) + '-' + String((m % 12) + 1).padStart(2, '0');
  const syncTime = () => {
    let lo = Number(t0.value), hi = Number(t1.value);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    state.monthMin = lo; state.monthMax = hi;
    $('f-time-out').textContent = label(lo) + ' to ' + label(hi);
    applyFilters();
  };
  t0.addEventListener('input', syncTime);
  t1.addEventListener('input', syncTime);
  syncTime();

  // Exaggeration
  const ex = $('f-exag');
  ex.addEventListener('input', () => {
    state.exag = Number(ex.value);
    $('f-exag-out').textContent = state.exag === 1 ? 'True scale (1x)' : state.exag.toFixed(1) + 'x exaggerated';
    applyFilters();
  });

  // Toggles
  const assignedToggle = $('f-assigned');
  assignedToggle.checked = state.showAssigned;
  assignedToggle.addEventListener('change', () => { state.showAssigned = assignedToggle.checked; applyFilters(); });
  $('assigned-count').textContent = fmt(c.defaultDepth);
  $('assigned-swatch').style.background = getComputedStyle(document.documentElement).getPropertyValue('--assigned').trim();

  const slabToggle = $('f-slabs');
  slabToggle.checked = state.showSlabs;
  slabToggle.addEventListener('change', () => { state.showSlabs = slabToggle.checked; applyFilters(); });

  const coastToggle = $('f-coast');
  coastToggle.checked = state.showCoast;
  coastToggle.addEventListener('change', () => { state.showCoast = coastToggle.checked; applyFilters(); });

  // Zones
  const list = $('zone-list');
  const sorted = manifest.zones.slice().sort((a, b) => b.events - a.events);
  list.innerHTML = '';
  for (const z of sorted) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.code = z.code;
    btn.innerHTML = '<span>' + escapeHtml(z.name) + '</span>'
      + (z.overturns ? '<span class="overturn" title="This slab overturns past vertical">OVERTURNS</span>' : '')
      + '<span class="zcount">' + fmt(z.events) + '</span>';
    btn.addEventListener('click', () => {
      const already = state.zone === (manifest.zones.findIndex((x) => x.code === z.code) + 1);
      selectZone(already ? null : z.code);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  $('f-zone-clear').addEventListener('click', () => selectZone(null));

  // Search
  const search = $('f-search');
  const results = $('search-results');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (q.length < 2) { results.hidden = true; return; }
    const hits = manifest.regions
      .map((r, i) => ({ ...r, i }))
      .filter((r) => r.name.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    if (hits.length === 0) {
      results.innerHTML = '<li><span class="no-hit">No catalogued region matches that.</span></li>';
      results.hidden = false;
      return;
    }
    for (const hit of hits) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span>' + escapeHtml(hit.name) + '</span><span class="zcount">' + fmt(hit.count) + '</span>';
      b.addEventListener('click', () => {
        flyTo(hit.lon, hit.lat, 1.05 + Math.min(1.6, hit.span / 22));
        results.hidden = true;
        search.value = hit.name;
      });
      li.appendChild(b);
      results.appendChild(li);
    }
    results.hidden = false;
  });
  search.addEventListener('blur', () => { window.setTimeout(() => { results.hidden = true; }, 180); });

  // Section tool
  const sectionBtn = $('f-section');
  sectionBtn.addEventListener('click', () => {
    state.sectionMode = !state.sectionMode;
    sectionBtn.setAttribute('aria-pressed', String(state.sectionMode));
    sectionBtn.textContent = state.sectionMode ? 'Click two points on the globe' : 'Draw a cross section';
    if (state.sectionMode) { state.sectionA = null; state.sectionB = null; sectionLine.visible = false; needsRender = true; }
  });
  $('section-close').addEventListener('click', () => {
    $('panel-section').hidden = true;
    document.body.classList.remove('section-open');
    state.sectionA = null; state.sectionB = null;
    sectionLine.visible = false;
    state.sectionMode = false;
    sectionBtn.setAttribute('aria-pressed', 'false');
    sectionBtn.textContent = 'Draw a cross section';
    needsRender = true;
  });
  const corridor = $('f-corridor');
  corridor.addEventListener('input', () => {
    state.corridorKm = Number(corridor.value);
    $('f-corridor-out').textContent = '+/- ' + state.corridorKm + ' km';
    redrawSection();
  });
  $('f-corridor-out').textContent = '+/- ' + state.corridorKm + ' km';

  // Preset sections, so the feature is discoverable without a drag.
  document.querySelectorAll('[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [a, b] = JSON.parse(btn.dataset.section);
      state.sectionA = a; state.sectionB = b;
      updateSectionLine();
      redrawSection();
      const mid = slerpGeo(a, b, 0.5);
      // Frame the section itself rather than a fixed distance: the line is the subject.
      const arc = greatCircleKm(a, b) / EARTH_RADIUS_KM;
      flyTo(mid[0], mid[1], Math.max(0.4, Math.min(2.4, ((arc / 2) / HALF_FOV) * 2.4)));
    });
  });

  // Mobile sheet. The controls start closed so the stage is visible on a phone; opening is
  // one tap and the state is reflected on the button for assistive technology.
  const sheet = $('sheet-toggle');
  if (sheet) {
    sheet.addEventListener('click', () => {
      const open = document.body.classList.toggle('sheet-open');
      sheet.setAttribute('aria-expanded', String(open));
      if (!open) $('panel-controls').scrollTop = 0;
    });
  }

  // Theme
  const theme = $('f-theme');
  theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'daylight' ? 'dusk' : 'daylight';
    document.documentElement.dataset.theme = next;
    theme.textContent = next === 'daylight' ? 'Dusk' : 'Daylight';
    theme.setAttribute('aria-label', 'Switch to the ' + (next === 'daylight' ? 'dusk' : 'daylight') + ' palette');
    try { localStorage.setItem('dipmeter-theme', next); } catch { /* private mode */ }
    ramp = readDepthRamp();
    assignedColor = readColor('--assigned', [0.62, 0.02, 255]);
    for (const mat of [points.material, slabMesh.material]) {
      mat.uniforms.uRamp0.value = ramp[0];
      mat.uniforms.uRamp70.value = ramp[1];
      mat.uniforms.uRamp300.value = ramp[2];
      mat.uniforms.uRamp700.value = ramp[3];
    }
    points.material.uniforms.uAssignedColor.value = assignedColor;
    points.material.blending = isAdditive() ? 2 : 1;
    points.material.needsUpdate = true;
    $('assigned-swatch').style.background = getComputedStyle(document.documentElement).getPropertyValue('--assigned').trim();
    needsRender = true;
    if (state.sectionA) redrawSection();
  });

  // Facts
  $('fact-events').textContent = fmt(c.events);
  $('fact-shallow').textContent = fmt(c.regimes.shallow);
  $('fact-intermediate').textContent = fmt(c.regimes.intermediate);
  $('fact-deep').textContent = fmt(c.regimes.deep);
  $('fact-deep500').textContent = fmt(c.regimes.deeperThan500);
  $('fact-above').textContent = fmt(c.aboveSeaLevel);
  $('fact-assigned').textContent = fmt(c.defaultDepth);
  $('fact-attributed').textContent = fmt(c.attributedToASlab);
  // The load-bearing ratio: depth is not spread through the Earth, it is confined to slabs.
  const deepTotal = c.regimes.intermediate + c.regimes.deep;
  const deepAttributed = manifest.zones.reduce((a, z) => a + z.deepEvents, 0);
  $('fact-deep-attributed').textContent = fmt(deepAttributed)
    + ' (' + (100 * deepAttributed / deepTotal).toFixed(1) + '%)';
  $('key-fact').innerHTML = '<b>' + (100 * deepAttributed / deepTotal).toFixed(1)
    + '%</b> of the ' + fmt(deepTotal) + ' events at 70 km or deeper fall inside one of these '
    + manifest.zones.length + ' modelled slabs. Depth is not spread through the Earth. It is '
    + 'confined to descending plates.';
  $('fact-triangles').textContent = fmt(slabs.triangles);
  $('fact-coast').textContent = fmt(coastSegments);

  // Pointer behaviour
  const canvas = $('gl');
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 500;
    downAt = null;
    if (moved > 6 || !quick) return;

    if (state.sectionMode) {
      const g = screenToGeo(e.clientX, e.clientY);
      if (!g) return;
      if (!state.sectionA) {
        state.sectionA = g;
        sectionBtn.textContent = 'Now click the far end';
      } else {
        state.sectionB = g;
        state.sectionMode = false;
        sectionBtn.setAttribute('aria-pressed', 'false');
        sectionBtn.textContent = 'Draw a cross section';
        updateSectionLine();
        redrawSection();
      }
      return;
    }
    showTip(pickAt(e.clientX, e.clientY), e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', () => { $('tip').hidden = true; });

  // Keyboard: the globe is reachable and operable without a pointer.
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.28 : 0.09;
    let handled = true;
    if (e.key === 'ArrowLeft') scene.controls.rotateLeft(-step);
    else if (e.key === 'ArrowRight') scene.controls.rotateLeft(step);
    else if (e.key === 'ArrowUp') scene.controls.rotateUp(step);
    else if (e.key === 'ArrowDown') scene.controls.rotateUp(-step);
    else if (e.key === '+' || e.key === '=') scene.controls.dollyIn(1.12);
    else if (e.key === '-' || e.key === '_') scene.controls.dollyOut(1.12);
    else handled = false;
    if (handled) { e.preventDefault(); scene.controls.update(); needsRender = true; }
  });
}

function selectZone(code) {
  const idx = code ? manifest.zones.findIndex((z) => z.code === code) + 1 : 0;
  state.zone = idx;
  document.querySelectorAll('#zone-list button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.code === code));
  });
  const z = idx ? manifest.zones[idx - 1] : null;
  $('zone-caption').textContent = z
    ? z.name + ': ' + fmt(z.events) + ' events, ' + fmt(z.deepEvents) + ' of them at 70 km or deeper'
      + (z.overturns ? '. This slab overturns past vertical.' : '.')
    : 'All 27 slabs shown.';
  if (code) frameZone(code); else frameGlobal();
  applyFilters();
}

// ---- Start ---------------------------------------------------------------------------------

try {
  const saved = localStorage.getItem('dipmeter-theme');
  if (saved === 'daylight') {
    document.documentElement.dataset.theme = 'daylight';
    const t = $('f-theme');
    if (t) t.textContent = 'Dusk';
  }
} catch { /* private mode */ }

boot().catch((err) => {
  // A failure here must not leave a blank stage pretending to be a scene.
  document.body.classList.remove('has-webgl');
  document.body.classList.add('no-webgl');
  const loading = $('loading');
  if (loading) loading.hidden = true;
  const note = $('fallback-reason');
  if (note) {
    note.hidden = false;
    note.textContent = 'The interactive globe failed to start (' + (err && err.message ? err.message : String(err))
      + '). Everything below is the full dataset in table form.';
  }
  console.error(err);
});
