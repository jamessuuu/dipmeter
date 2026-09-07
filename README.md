# dipmeter

**230,059 located hypocentres against 27 modelled slabs.**

Every located earthquake of magnitude 4.5 and above since 1990, drawn at its real depth inside a
transparent Earth against the 27 subduction surfaces USGS actually modelled, so the slabs stop being
blobs on a map and become the dipping planes they are.

A dipmeter is the borehole instrument that measures the dip of a geological bed. The dip of the
subducting slab is the whole subject.

> **This is not a hazard map.** It shows where earthquakes have been recorded. It does not forecast,
> and no probability, risk or hazard claim appears anywhere in the project.

---

## Every number here is computed, never typed

`public/data/manifest.json` is generated from the files on disk by `scripts/build-data.mjs`, and it
is the only place the page reads a figure from. `scripts/verify.mjs` independently re-derives every
headline number from the raw sources, separately decodes the shipped binaries, and fails if the two
disagree.

```
npm run verify      # 67 checks, every figure recomputed from data on disk
```

The brief this was built from expected 229,956 events. The real count fetched on 2026-09-07 is
**230,059**, and 230,059 is what the page renders. Catalogues are revised continuously; the
difference is reported rather than reconciled.

---

## Dataset provenance

### 1. USGS ANSS ComCat earthquake catalogue

| | |
|---|---|
| **URL** | `https://earthquake.usgs.gov/fdsnws/event/1/query` (FDSN event service) |
| **Query** | `format=csv`, `minmagnitude=4.5`, `orderby=time-asc`, in 37 yearly chunks from 1990-01-01, because the service caps a single response at 20,000 rows |
| **Licence** | **U.S. Public Domain.** USGS-authored data carries no copyright: <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits> |
| **Fetched** | **2026-09-07** (`data/raw/comcat-fetch-manifest.json` records the exact timestamp and per-chunk byte counts) |
| **Measured size** | **40,051,116 B** of CSV (`data/raw/comcat-m45-1990-2026.csv`) |
| **Parsed records** | **230,060** data rows, of which **230,059** are kept |
| **First / last event** | 1990-01-01T07:49:35Z to 2026-09-07T02:30:21Z |
| **Depth range** | **−3.0 km to 700.9 km** |
| **Magnitude range** | **4.5 to 9.1** |
| **Missing data** | **Zero.** Every kept row carries latitude, longitude, depth and magnitude |

**One row was dropped.** Event `nc21364840` (2004-05-17, "12 km NNE of Cayucos, California") comes
back from a `minmagnitude=4.5` query but reports a preferred magnitude of **3.38 ml**: the service
matched it on a magnitude other than the one it reports. The brief forbids anything below M4.5, so
it is excluded, named in the manifest, and counted here rather than silently kept.

**No `eventtype` filter was applied.** The service would happily have returned earthquakes only, but
then the exclusions would be invisible. Everything above M4.5 was taken and classified on the
catalogue's own `type` column instead, so the non-earthquakes are a printed number:

| Catalogue type | Events |
|---|---:|
| earthquake | 229,934 |
| volcanic eruption | 71 |
| nuclear explosion | 45 |
| landslide | 3 |
| mine collapse | 2 |
| rock burst | 2 |
| explosion | 2 |

### 2. USGS Slab2 subduction zone geometry model

| | |
|---|---|
| **URL** | ScienceBase item `5aa1b00ee4b0b1c392e86467` |
| **DOI** | [10.5066/F7PV6JNV](https://doi.org/10.5066/F7PV6JNV) — Hayes et al. 2018, *Slab2, a comprehensive subduction zone geometry model* |
| **Licence** | **U.S. Public Domain.** The shipped FGDC metadata (`data/raw/Slab2.xml`) carries `<useconst>none</useconst>` and `<accconst>none</accconst>`. `scripts/fetch-slab2.mjs` asserts both and refuses to proceed if either ever changes |
| **Fetched** | **2026-09-07** |
| **Archive size** | **140,213,438 B** (`Slab2Distribute_Mar2018.tar.gz`, 472 entries) |
| **Depth grids** | **27 files, 3,485,379 B** (`data/raw/slab2/*_dep_*.grd`) — committed |
| **Clip polygons** | 27 files, 138,526 B — committed |
| **Supplementary node files** | **4 files, 16,501,841 B** |
| **ASCII grid twins** | 27 files, 125,266,978 B (`Slab2_TXT/*_dep_*.xyz`) — the build reads these |

**Why the build reads `.xyz` and not `.grd`.** The `.grd` files are netCDF-4, which is HDF5: their
first four bytes are `89 48 44 46`. Reading HDF5 needs a B-tree plus chunked-deflate reader.
Slab2 ships `Slab2_TXT/*.xyz`, which is the *same grid* as plain `lon,lat,depth` ASCII, so the build
parses that and keeps the `.grd` files as the citable primary artifact. `scripts/verify.mjs` checks
each shipped grid's dimensions, node count and valid-node count against the source it came from.

**Grid spacing is measured, not assumed.** 26 zones are on a 0.05 degree grid; **Hindu Kush is on
0.02**. Assuming 0.05 everywhere produced a 221 x 181 grid for a 248,501-row file and the reader
threw rather than rendering a sheared surface.

**Four zones overturn past vertical**, and this is the fact that makes Slab2 genuinely
three-dimensional rather than a height field. A depth grid alone is a surface. But `Slab2Supp/`
contains supplementary node files for exactly the zones whose surface folds back over itself and
cannot be expressed as any single-valued *z(x, y)*. There are **four** such files, and their
existence — not an assertion in this README — is where the count of four comes from:

| Code | Zone | Nodes in the supplementary file |
|---|---|---:|
| `izu` | Izu-Bonin | 97,646 |
| `ker` | Kermadec-Tonga | 81,532 |
| `man` | Manila | 66,171 |
| `sol` | Solomon Islands | 48,307 |

### 3. Natural Earth 1:110m coastline

| | |
|---|---|
| **URL** | <https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_coastline.geojson> |
| **Licence** | **Public domain.** The repository's own `LICENSE.md` opens "Everything here is public domain." A copy is vendored at `data/raw/natural-earth-LICENSE.md` |
| **Fetched** | **2026-09-07** |
| **Measured size** | **139,907 B** of GeoJSON |
| **Parsed records** | **134 line strands, 5,128 coordinate pairs** |

---

## What the risk probe found, before any renderer existed

The brief pre-registered two kill conditions and a rule that if neither could be made honest, the
project stops. `scripts/probe-risk.mjs` ran them on day one, with no 3D code involved. Full output:
[`docs/risk-probe.md`](docs/risk-probe.md).

**Kill condition 2 fired.** 106,108 of 230,059 events (**46.1%**) sit at exactly 10, 33 or 35 km:
the depths a locator assigns when it cannot solve for one. That is a real property of ComCat and it
is not negotiable away. All three values are shallower than 70 km, so the damage is concentrated
entirely in the shallow band, where it affects **59.0% of the 179,798 shallow events** and none of
the 50,261 events at 70 km or deeper. The prescribed mitigation is therefore sufficient and is
implemented:
assigned-depth events are their own render class, in their own colour, with their own printed count
and their own visibility control, so a visitor can remove every assigned depth from the scene and
watch what survives.

**Kill condition 1 did not fire**, and the measurement that settles it is not a hand-drawn box.
Every event at 70 km or deeper was compared with the Slab2 surface directly beneath it, using 27
surfaces published by somebody else:

| Quantity | Value |
|---|---:|
| Events at 70 km or deeper | 50,260 |
| Inside some Slab2 footprint | 49,165 |
| Outside every Slab2 footprint | 1,095 |
| Median residual (event depth minus surface depth) | **+41.6 km** |
| **Robust full width (2 × 1.4826 × MAD)** | **69.6 km** |
| Within 50 km of the modelled surface | 28,336 (57.6%) |

The probe's figures are computed on the **raw** CSV decimals, because it ran before any encoding
existed. The page's figures are computed on the **quantised** values it actually draws, so a few
counts differ by a handful of events: the probe finds 106,052 events at a default depth and 50,260
at 70 km or deeper, where the page finds 106,108 and 50,261. Both are correct about their own
subject, and neither is rounded toward the other.

A subducting slab is 50 to 100 km thick. A robust full width of **69.6 km** means the hypocentres
*are* the sheet. The systematic **+41.6 km** median is not an error either: Slab2 models the top of
the slab, and intraslab seismicity sits below that interface, which is exactly where these events
are.

---

## Honesty rules this project holds itself to

1. **No invented numbers.** Every count in the UI comes from `manifest.json`, generated from disk.
   `npm run verify` recomputes all of them from the raw sources and exits non-zero on any mismatch.
2. **Counts describe what is drawn.** Values are quantised *before* anything is counted (depth to
   0.02 km, magnitude to 0.1), because the page renders the quantised values. An earlier build
   counted raw CSV decimals while rendering quantised ones; `verify.mjs` caught the disagreement in
   five separate checks and the packer was changed rather than the checks.
3. **Decimation is printed, not implied.** The no-JavaScript fallback draws 2,377 marks for 230,059
   events and says so, in the fallback itself: "a decimation of 1 in 97".
4. **Vertical exaggeration is printed.** The cross-section panel states the exact vertical scale
   factor and whether the plane is therefore drawn steeper or shallower than its true dip. Depth
   exaggeration on the globe defaults to **true scale (1x)** and the factor is always on screen.
5. **The 660 km sphere is labelled as a reference surface, not data.**
6. **No count-ups.** 230,059 renders as 230,059 on the first frame.
7. **No hazard language anywhere.**

---

## Measured sizes

Run `npm run build && npm run measure`. Written to [`docs/bundle-report.json`](docs/bundle-report.json).

### What boots the page

| File | Raw | Gzip | Brotli |
|---|---:|---:|---:|
| `assets/index.js` | 658,714 | **167,038** | 123,333 |
| `assets/index.css` | 15,722 | 3,979 | 3,464 |
| `index.html` | 251,499 | 33,865 | 27,149 |
| **Shell total** | **925,935** | **204,882** | **153,946** |

Of the JavaScript, **625,520 B raw / 156,313 B gzip is three.js** and **33,194 B raw / 10,725 B gzip
is application code**, measured by building a probe that imports exactly the classes `src/globe.js`
imports, through the same bundler and minifier. The stated budget was 165 KiB gzip for JavaScript;
the bundle is **1,922 B under it**.

`index.html` is 251 KB raw because it carries the entire no-JavaScript fallback as served markup:
2,377 SVG marks, every facet table, and the complete 594-region search index.

### Data payload, loaded after first paint

| File | Raw | Gzip | Brotli |
|---|---:|---:|---:|
| `events-a.bin` (62,629 events, M5.0+) | 814,193 | 457,423 | 430,655 |
| `events-b.bin` (167,430 events, M4.5–4.9) | 2,176,606 | 1,179,010 | 1,120,388 |
| `slabs.bin` (27 decimated surfaces) | 729,000 | 102,878 | 83,858 |
| `coast.bin` | 21,064 | 20,348 | 19,731 |
| `manifest.json` | 94,365 | 16,866 | 13,402 |
| **Total** | **3,835,228** | **1,776,525** | **1,668,034** |

Tier A paints first; tier B streams in behind it.

### Against the reference

`https://human-atlas-seven.vercel.app/`, fetched and compressed with identical settings by
`scripts/measure-reference.mjs` on 2026-09-07 — measured, not quoted:

| | Reference | dipmeter | Difference |
|---|---:|---:|---:|
| JavaScript, raw | 916,370 | 658,714 | **−28.1%** |
| JavaScript, gzip | 260,993 | 167,038 | **−36.0%** |
| Shell total, raw | 1,113,585 | 925,935 | **−16.9%** |
| Shell total, gzip | 292,274 | 204,882 | **−29.9%** |
| Shell total, brotli | 243,784 | 153,946 | **−36.9%** |

The brief quoted 260,791 B gzip for the reference's JavaScript; measured here it is 260,993 B. The
202-byte gap is compressor settings, and it is exactly why the comparison is re-measured rather than
trusted.

---

## How it is built

**Binary format.** Events are packed as a structure of arrays, which compresses far better than
interleaved records because each array has low entropy: `lat` int16, `lon` int16, `depth` uint16,
`month` uint16, `region` uint16, `mag` uint8, `flags` uint8, `zone` uint8. Eleven bytes per event,
with a 16-byte self-describing header whose magic and length the reader checks.

**Filtering happens on the GPU.** Depth, magnitude, time, assigned-depth class and zone are all
uniforms evaluated in the vertex shader, so dragging a slider never touches a CPU-side buffer and
never rebuilds geometry. The spherical transform from lon/lat/depth also happens in the shader, so
depth exaggeration is free.

**Slab surfaces are never bridged.** The mesh builder emits a triangle only where all four corners
of a grid cell carry a modelled depth, so a slab edge is a real edge rather than invented geometry.

**Picking does not use a raycaster.** The shader decides visibility, so three.js has no idea which
points are on screen. A click projects the currently visible set and takes the nearest — one pass
over the arrays, which is cheap for a pointer event and exactly correct.

**three.js is imported by name.** Importing the namespace costs about 190 KB gzip; this working set
costs 156 KB, and the difference is most of the page's JavaScript budget.

---

## Commands

```
npm install
npm run fetch          # download ComCat + Slab2 (needs network, ~140 MB, resumable)
npm run probe          # the pre-registered risk probe -> docs/risk-probe.md
npm run build:data     # pack the binaries and regenerate manifest.json
npm run build          # generates the fallback, then builds with Vite
npm run verify         # recompute every headline number from disk
npm run measure        # bundle sizes, raw / gzip / brotli
npm run preview        # serve dist/
npm run shots          # drive the built page with Playwright and prove it renders
```

`npm run shots` refuses to run against a `dist/` older than `src/`: a screenshot run against a stale
build reports a green result for code that does not compile, which happened once during development.

## Accessibility and degradation

- **No WebGL2:** the decimated SVG and the complete tables are already in the served HTML, so
  nothing is injected and nothing is apologised for. They simply become visible.
- **No JavaScript:** same content, because it is served markup rather than rendered markup.
- **Reduced motion:** camera flights become instantaneous, damping is off, and every state stays
  reachable.
- **Keyboard:** the canvas is focusable and driven by the arrow keys and `+` / `-`. Every control is
  a real form control with a label.
- **Touch targets:** 44 px minimum. On phones the controls are a bottom sheet that starts closed, so
  the stage is visible.
- **Themes:** dusk by default, daylight available; the depth ramp shifts lightness so the same depth
  ordering survives on a pale ground.

## Repository layout

```
data/raw/            vendored sources + fetch manifests (large files gitignored, provenance kept)
docs/                risk probe, bundle report, fallback stats, screenshots
public/data/         the shipped binary payload and manifest.json
scripts/             fetch, probe, pack, fallback, verify, measure, screenshots
src/                 the application
```

## Sources and credit

- Earthquake catalogue: **USGS ANSS ComCat**, U.S. Public Domain.
- Subduction geometry: **Hayes, G.P., et al. (2018), Slab2**, U.S. Public Domain, DOI 10.5066/F7PV6JNV.
- Coastlines: **Natural Earth**, public domain. Made with Natural Earth.
- Rendering: **three.js** 0.185.1 (MIT).

Project code is MIT licensed. The data keeps its own terms, all of which are quoted above.
