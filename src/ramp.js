// OKLCH is the authoring space for this project, in CSS and on the GPU alike. The four
// depth stops are declared once in styles.css as --depth-0 / --depth-70 / --depth-300 /
// --depth-700; this module reads those declarations at runtime and converts them, so the
// legend swatch and the 230,059 points on the globe can never drift apart.

// OKLCH -> OKLab -> LMS -> linear sRGB. Bjorn Ottosson's matrices.
export function oklchToLinearSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

export function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(1, v));
}

export function oklchToHex(L, C, h) {
  const [r, g, b] = oklchToLinearSrgb(L, C, h).map(linearToSrgb);
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

// Parses "oklch(0.72 0.19 32)" or "oklch(0.72 0.19 32 / 0.5)".
export function parseOklch(str) {
  const m = /oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)/i.exec(str);
  if (!m) return null;
  const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  return { L, C: parseFloat(m[2]), h: parseFloat(m[3]) };
}

export const DEPTH_STOPS_KM = [0, 70, 300, 700];

// Reads the four --depth-* custom properties off the document and returns their linear-sRGB
// triples, ready to hand to a shader uniform.
export function readDepthRamp(el) {
  const cs = getComputedStyle(el || document.documentElement);
  return DEPTH_STOPS_KM.map((km) => {
    const raw = cs.getPropertyValue('--depth-' + km).trim();
    const p = parseOklch(raw);
    // If a browser resolves the custom property to something other than an oklch() literal
    // we fall back to a hard-coded equivalent rather than rendering an invisible scene.
    if (!p) return oklchToLinearSrgb(...FALLBACK[km]);
    return oklchToLinearSrgb(p.L, p.C, p.h);
  });
}

const FALLBACK = {
  0: [0.72, 0.19, 32],
  70: [0.80, 0.16, 78],
  300: [0.68, 0.16, 305],
  700: [0.76, 0.13, 218],
};

export function readColor(name, fallbackLCH) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const p = parseOklch(raw);
  return p ? oklchToLinearSrgb(p.L, p.C, p.h) : oklchToLinearSrgb(...fallbackLCH);
}

// CPU-side twin of the shader's ramp, for the legend, the cross section and the tooltip.
export function depthColorHex(depthKm, ramp) {
  const stops = DEPTH_STOPS_KM;
  let i = 0;
  while (i < stops.length - 2 && depthKm > stops[i + 1]) i += 1;
  const t = Math.max(0, Math.min(1, (depthKm - stops[i]) / (stops[i + 1] - stops[i])));
  const a = ramp[i];
  const b = ramp[i + 1];
  const lin = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const to = (x) => Math.round(linearToSrgb(x) * 255).toString(16).padStart(2, '0');
  return '#' + to(lin[0]) + to(lin[1]) + to(lin[2]);
}
