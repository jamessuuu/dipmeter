// The scene. three.js classes are imported by name, never as a namespace: importing the full
// namespace costs about 190 KB gzip where this working set costs about 138 KB, and the
// difference is most of the page's JavaScript budget.

import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import { BufferGeometry } from 'three/src/core/BufferGeometry.js';
import { BufferAttribute } from 'three/src/core/BufferAttribute.js';
import { Points } from 'three/src/objects/Points.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import { LineSegments } from 'three/src/objects/LineSegments.js';
import { Line } from 'three/src/objects/Line.js';
import { ShaderMaterial } from 'three/src/materials/ShaderMaterial.js';
import { LineBasicMaterial } from 'three/src/materials/LineBasicMaterial.js';
import { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Color } from 'three/src/math/Color.js';
import { Group } from 'three/src/objects/Group.js';
import { AdditiveBlending, NormalBlending, DoubleSide, BackSide, SRGBColorSpace } from 'three/src/constants.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { NODATA } from './data.js';

export const EARTH_RADIUS_KM = 6371;

// Depth of the base of the mantle transition zone. Deep-focus seismicity stops within a few
// tens of kilometres of it worldwide, which is why it is drawn: it is the floor of the data.
export const TRANSITION_ZONE_KM = 660;

export function geoToVec(lonDeg, latDeg, depthKm, exaggeration, out) {
  const r = 1 - (depthKm * exaggeration) / EARTH_RADIUS_KM;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  const v = out || new Vector3();
  return v.set(r * c * Math.cos(lon), r * Math.sin(lat), -r * c * Math.sin(lon));
}

const POINT_VERT = `
precision highp float;
attribute vec2 aLonLat;
attribute float aDepth;
attribute float aMag;
attribute float aMonth;
attribute float aFlags;
attribute float aZone;

uniform float uExag;
uniform vec2 uDepthRange;
uniform float uMagMin;
uniform vec2 uMonthRange;
uniform float uShowAssigned;
uniform float uZoneFilter;
uniform float uPointScale;
uniform float uPixelRatio;
uniform vec3 uRamp0;
uniform vec3 uRamp70;
uniform vec3 uRamp300;
uniform vec3 uRamp700;
uniform vec3 uAssignedColor;
uniform float uHighlightZone;

varying vec3 vColor;
varying float vAlpha;

vec3 depthColor(float d) {
  if (d < 70.0) return mix(uRamp0, uRamp70, clamp(d / 70.0, 0.0, 1.0));
  if (d < 300.0) return mix(uRamp70, uRamp300, (d - 70.0) / 230.0);
  return mix(uRamp300, uRamp700, clamp((d - 300.0) / 400.0, 0.0, 1.0));
}

void main() {
  bool assigned = mod(aFlags, 2.0) >= 1.0;

  // Every filter is evaluated here rather than by rebuilding the geometry, so dragging a
  // slider never touches the CPU-side buffers.
  bool visible = aDepth >= uDepthRange.x && aDepth <= uDepthRange.y
    && aMag >= uMagMin
    && aMonth >= uMonthRange.x && aMonth <= uMonthRange.y
    && (uShowAssigned > 0.5 || !assigned)
    && (uZoneFilter < 0.5 || abs(aZone - uZoneFilter) < 0.5);

  if (!visible) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  float r = 1.0 - (aDepth * uExag) / ${EARTH_RADIUS_KM.toFixed(1)};
  float la = radians(aLonLat.y);
  float lo = radians(aLonLat.x);
  float c = cos(la);
  vec3 p = vec3(r * c * cos(lo), r * sin(la), -r * c * sin(lo));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // A magnitude 8 is not 1.8x the dot of a magnitude 4.5; it is a different kind of event.
  // Size grows with magnitude but stays inside a range where a dense sheet still reads.
  float size = (0.55 + (aMag - 4.5) * 0.42) * uPointScale * uPixelRatio;
  gl_PointSize = clamp(size / max(-mv.z, 0.02), 1.0, 22.0);

  vColor = assigned ? uAssignedColor : depthColor(aDepth);
  vAlpha = assigned ? 0.30 : 0.78;
  if (uHighlightZone > 0.5) {
    vAlpha *= (abs(aZone - uHighlightZone) < 0.5) ? 1.0 : 0.16;
  }
}
`;

const POINT_FRAG = `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float edge = smoothstep(0.25, 0.06, r2);
  gl_FragColor = vec4(vColor, vAlpha * edge);
}
`;

const SLAB_VERT = `
precision highp float;
attribute float aDepth;
attribute float aZone;
uniform float uExag;
uniform float uZoneFilter;
uniform vec3 uRamp0;
uniform vec3 uRamp70;
uniform vec3 uRamp300;
uniform vec3 uRamp700;
varying vec3 vColor;
varying float vFacing;
varying float vHidden;

vec3 depthColor(float d) {
  if (d < 70.0) return mix(uRamp0, uRamp70, clamp(d / 70.0, 0.0, 1.0));
  if (d < 300.0) return mix(uRamp70, uRamp300, (d - 70.0) / 230.0);
  return mix(uRamp300, uRamp700, clamp((d - 300.0) / 400.0, 0.0, 1.0));
}

void main() {
  vHidden = (uZoneFilter > 0.5 && abs(aZone - uZoneFilter) > 0.5) ? 1.0 : 0.0;
  vec3 p = position;
  // The stored position is the unit-sphere direction; depth is applied here so the
  // exaggeration control moves surfaces and hypocentres together, by the same factor.
  float r = 1.0 - (aDepth * uExag) / ${EARTH_RADIUS_KM.toFixed(1)};
  p = normalize(p) * r;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(n.z);
  vColor = depthColor(aDepth);
}
`;

const SLAB_FRAG = `
precision highp float;
varying vec3 vColor;
varying float vFacing;
varying float vHidden;
uniform float uOpacity;
void main() {
  if (vHidden > 0.5) discard;
  // Grazing angles read brighter, which is what makes a dipping plane legible as a plane.
  float rim = 1.0 - vFacing;
  gl_FragColor = vec4(vColor * (0.55 + 0.75 * rim), uOpacity * (0.35 + 0.65 * rim));
}
`;

export function createScene(canvas, options) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.005, 60);
  camera.position.set(0, 0.55, 2.6);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !options.reducedMotion;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  // Going inside the Earth is not an error here, it is the point, so the near limit is
  // small. The far limit keeps the globe from becoming a dot.
  controls.minDistance = 0.12;
  controls.maxDistance = 7;
  controls.enablePan = false;

  const root = new Group();
  scene.add(root);

  return { renderer, scene, camera, controls, root };
}

export function buildEarthShell(colors) {
  const group = new Group();

  // Outer surface: a back-face-only shell so the camera always looks THROUGH it rather than
  // at it. This is what makes the Earth transparent without any blending tricks.
  const shell = new Mesh(
    new SphereGeometry(1, 96, 64),
    new ShaderMaterial({
      transparent: true,
      side: BackSide,
      depthWrite: false,
      uniforms: { uColor: { value: new Color(...colors.shell) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vP;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vP = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        uniform vec3 uColor; varying vec3 vN; varying vec3 vP;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.4);
          gl_FragColor = vec4(uColor, f * 0.55);
        }`,
    })
  );
  group.add(shell);

  // The 660 km discontinuity, drawn as a wire sphere because it is where deep seismicity
  // stops. It is a reference surface, not data, and the legend says so.
  const tz = new Mesh(
    new SphereGeometry(1 - TRANSITION_ZONE_KM / EARTH_RADIUS_KM, 64, 40),
    new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      wireframe: true,
      uniforms: { uColor: { value: new Color(...colors.transition) }, uAlpha: { value: 0.055 } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'precision highp float; uniform vec3 uColor; uniform float uAlpha; void main() { gl_FragColor = vec4(uColor, uAlpha); }',
    })
  );
  tz.name = 'transitionZone';
  group.add(tz);

  return group;
}

export function buildCoastlines(coast, color) {
  // One LineSegments for every strand, merged into a single buffer.
  let segs = 0;
  for (const line of coast.lines) segs += (line.length / 2) - 1;
  const pos = new Float32Array(segs * 6);
  const v = new Vector3();
  let k = 0;
  for (const line of coast.lines) {
    const n = line.length / 2;
    for (let i = 0; i < n - 1; i += 1) {
      geoToVec(line[i * 2], line[i * 2 + 1], 0, 1, v);
      pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z;
      geoToVec(line[(i + 1) * 2], line[(i + 1) * 2 + 1], 0, 1, v);
      pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z;
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  const mat = new LineBasicMaterial({ color: new Color(...color), transparent: true, opacity: 0.42, depthWrite: false });
  const mesh = new LineSegments(geom, mat);
  mesh.name = 'coastlines';
  return { mesh, segments: segs };
}

export function buildPoints(events, ramp, assignedColor, reducedMotion, additive) {
  const n = events.count;
  const lonLat = new Float32Array(n * 2);
  // Position is a required attribute for three's frustum handling; the shader recomputes the
  // real position from lon/lat/depth, so this is the surface projection used only for bounds.
  const position = new Float32Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i += 1) {
    lonLat[i * 2] = events.lon[i];
    lonLat[i * 2 + 1] = events.lat[i];
    geoToVec(events.lon[i], events.lat[i], events.depth[i], 1, v);
    position[i * 3] = v.x; position[i * 3 + 1] = v.y; position[i * 3 + 2] = v.z;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(position, 3));
  geom.setAttribute('aLonLat', new BufferAttribute(lonLat, 2));
  geom.setAttribute('aDepth', new BufferAttribute(events.depth, 1));
  geom.setAttribute('aMag', new BufferAttribute(events.mag, 1));
  geom.setAttribute('aMonth', new BufferAttribute(Float32Array.from(events.month), 1));
  geom.setAttribute('aFlags', new BufferAttribute(Float32Array.from(events.flags), 1));
  geom.setAttribute('aZone', new BufferAttribute(Float32Array.from(events.zone), 1));
  geom.computeBoundingSphere();

  const mat = new ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: {
      uExag: { value: 1 },
      uDepthRange: { value: [-100, 800] },
      uMagMin: { value: 4.5 },
      uMonthRange: { value: [0, 9999] },
      uShowAssigned: { value: 1 },
      uZoneFilter: { value: 0 },
      uHighlightZone: { value: 0 },
      uPointScale: { value: 3.4 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uRamp0: { value: ramp[0] },
      uRamp70: { value: ramp[1] },
      uRamp300: { value: ramp[2] },
      uRamp700: { value: ramp[3] },
      uAssignedColor: { value: assignedColor },
    },
  });
  const points = new Points(geom, mat);
  points.frustumCulled = false;
  points.name = 'hypocentres';
  return points;
}

// Walks each zone's decimated grid and emits two triangles per cell, but ONLY where all four
// corners carry a modelled depth. A slab edge is therefore a real edge: nothing is bridged.
export function buildSlabs(zones, ramp) {
  const positions = [];
  const depths = [];
  const zoneIds = [];
  const perZone = [];
  let triangles = 0;

  zones.forEach((z, zi) => {
    const { nx, ny, lonMin, latMin, step, depths: d } = z;
    let zTris = 0;
    const v = new Vector3();
    const push = (ix, iy) => {
      const lon = lonMin + ix * step;
      const lat = latMin + iy * step;
      const dep = d[iy * nx + ix] / 10;
      geoToVec(lon, lat, 0, 1, v); // unit direction; depth applied in the shader
      positions.push(v.x, v.y, v.z);
      depths.push(dep);
      zoneIds.push(zi + 1);
    };
    for (let iy = 0; iy < ny - 1; iy += 1) {
      for (let ix = 0; ix < nx - 1; ix += 1) {
        const a = d[iy * nx + ix];
        const b = d[iy * nx + ix + 1];
        const c = d[(iy + 1) * nx + ix];
        const e = d[(iy + 1) * nx + ix + 1];
        if (a === NODATA || b === NODATA || c === NODATA || e === NODATA) continue;
        push(ix, iy); push(ix + 1, iy); push(ix, iy + 1);
        push(ix + 1, iy); push(ix + 1, iy + 1); push(ix, iy + 1);
        zTris += 2;
      }
    }
    triangles += zTris;
    perZone.push({ code: z.code, triangles: zTris });
  });

  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('aDepth', new BufferAttribute(new Float32Array(depths), 1));
  geom.setAttribute('aZone', new BufferAttribute(new Float32Array(zoneIds), 1));
  geom.computeVertexNormals();
  geom.computeBoundingSphere();

  const mat = new ShaderMaterial({
    vertexShader: SLAB_VERT,
    fragmentShader: SLAB_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uExag: { value: 1 },
      uZoneFilter: { value: 0 },
      uOpacity: { value: 0.5 },
      uRamp0: { value: ramp[0] },
      uRamp70: { value: ramp[1] },
      uRamp300: { value: ramp[2] },
      uRamp700: { value: ramp[3] },
    },
  });
  const mesh = new Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.name = 'slabs';
  return { mesh, triangles, perZone, vertices: positions.length / 3 };
}

// The line the user drags for a cross section, drawn on the surface as a great circle.
export function buildSectionLine(color) {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(2 * 3 * 64), 3));
  const mat = new LineBasicMaterial({ color: new Color(...color), transparent: true, opacity: 0.95, depthTest: false });
  const line = new Line(geom, mat);
  line.name = 'sectionLine';
  line.renderOrder = 5;
  line.visible = false;
  return line;
}

export { Vector3, Color };
