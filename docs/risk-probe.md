# Risk probe: are the Wadati-Benioff planes actually in the catalogue?

Run `2026-09-07T03:18:58.084Z` by `scripts/probe-risk.mjs`, before any renderer existed.
Re-run with `npm run probe`. Every number is computed from
`data/raw/comcat-m45-1990-2026.csv` (230,060 data rows, 230,060 parsed)
and the 27 Slab2 depth grids in `data/raw/slab2-xyz/`.

## Kill condition 2: fixed default depths. TRIGGERED.

Threshold: more than about a third of events sitting at a fixed default depth means
those events are drawn differently and counted separately, or the depth axis is partly
fictional.

| Value | Events at exactly this depth | Share of catalogue |
|---|---:|---:|
| 10.0 km | 70,228 | 30.53% |
| 33.0 km | 24,408 | 10.61% |
| 35.0 km | 11,416 | 4.96% |
| **Any of the three** | **106,052** | **46.10%** |

Nearly half the catalogue sits on three round numbers. That is a real property of
ComCat and it is not negotiable away.

All three default values are shallower than 70 km, so no event at 70 km or deeper can
sit at one. That is arithmetic and it is stated here only so it is not mistaken for a
finding. The finding is where the damage is concentrated: **106,052 of the 179,800 events**
in the shallow band (59.0%) carry an assigned rather than a solved depth, while the 50,260 events at
70 km or deeper carry none. The shallow band is where the depth axis is soft, and it is
also the band that contributes least to the structure this page exists to show.

Mitigation, now mandatory: default-depth events are their own render class with their
own printed count and their own visibility control, so a visitor can remove every
assigned depth from the scene and watch what survives.

## Kill condition 1: does the plane read as a sheet?

### The global measurement, which is the one that decides it

Hand-drawn corridors measure the analyst as much as the Earth. This does not: every
event at 70 km or deeper is compared with the Slab2 surface directly beneath it, using
27 surfaces published by someone else.

| Quantity | Value |
|---|---:|
| Events at 70 km or deeper | 50,260 |
| Of those, inside some Slab2 footprint | 49,165 |
| Outside every Slab2 footprint | 1,095 |
| Median residual (event depth minus surface depth) | 41.6 km |
| Robust half width (1.4826 x MAD) | 34.8 km |
| **Robust full width** | **69.6 km** |
| 10th to 90th percentile spread | 99.2 km |
| Within 25 km of the modelled surface | 13,520 (27.5%) |
| Within 50 km of the modelled surface | 28,336 (57.6%) |

A subducting slab is 50 to 100 km thick. A robust full width of 69.6 km means the hypocentres are the sheet.

### The same question per zone

| Zone | Deep events | Median residual | Robust full width |
|---|---:|---:|---:|
| Kermadec-Tonga (`ker`) | 12,381 | 67.4 km | 83.1 km |
| South America (`sam`) | 6,461 | 20.8 km | 28.8 km |
| Sumatra-Java (`sum`) | 6,216 | 37.5 km | 53.0 km |
| Solomon Islands (`sol`) | 4,079 | 42.7 km | 61.1 km |
| Halmahera (`hal`) | 3,417 | 42.2 km | 64.2 km |
| Vanuatu (`van`) | 3,064 | 76.0 km | 75.6 km |
| Izu-Bonin (`izu`) | 2,973 | 40.3 km | 63.6 km |
| Kuril-Kamchatka-Japan (`kur`) | 2,909 | 31.2 km | 36.4 km |
| Philippines (`phi`) | 1,296 | 19.4 km | 66.3 km |
| Central America (`cam`) | 1,289 | 35.2 km | 37.9 km |
| Hindu Kush (`hin`) | 1,113 | 78.1 km | 79.8 km |
| Scotia Sea (`sco`) | 1,028 | 42.0 km | 40.4 km |
| Alaska-Aleutians (`alu`) | 644 | 22.5 km | 33.6 km |
| Ryukyu (`ryu`) | 570 | 34.0 km | 53.9 km |
| Manila (`man`) | 425 | 32.0 km | 58.9 km |
| Pamir (`pam`) | 343 | 30.8 km | 70.2 km |
| Caribbean (`car`) | 271 | 28.1 km | 46.7 km |
| Sulawesi (`sul`) | 206 | 22.0 km | 41.3 km |
| New Guinea (`png`) | 142 | 40.3 km | 44.0 km |
| Hellenic (`hel`) | 107 | 25.6 km | 32.8 km |
| Cotabato (`cot`) | 77 | 24.6 km | 57.2 km |
| Calabria (`cal`) | 59 | 47.3 km | 60.4 km |
| Puysegur (`puy`) | 45 | 47.6 km | 51.5 km |
| Muertos Trough (`mue`) | 23 | too few to fit | |
| Makran (`mak`) | 22 | too few to fit | |
| Himalaya (`him`) | 5 | too few to fit | |
| Cascadia (`cas`) | 0 | too few to fit | |

### The three hand-drawn corridors, kept for legibility

| Corridor | Events 70-300 km | Fitted dip | Robust full width | 10th-90th spread |
|---|---:|---:|---:|---:|
| Tonga | 824 | 29.8 deg | 84.1 km | 99.1 km |
| Northern Japan | 273 | 21.1 deg | 36.7 km | 39.2 km |
| Northern Chile | 1,682 | 25.4 deg | 28.6 km | 38.4 km |

A corridor fit assumes one planar slab inside the box. Where an arc is strongly curved
or carries a detached fragment, the box contains two structures and the fit widens. That
is a property of the box, not of the Earth, which is exactly why the global residual is
the number this project reports.

## Decision

**Proceed, with kill condition 2's mitigation made mandatory.**

- The hypocentres carry the image: global robust full width 69.6 km, inside the 50 to 100 km physical thickness of a slab.
- 106,052 events (46.1%) sit at a fixed default depth. They are drawn as a separate class, counted on the face
  of the page, and can be hidden with one control. None of them is deeper than 70 km.
