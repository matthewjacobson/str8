# str8

Modern straight-skeleton computation for the browser and Node, powered by
[CGAL](https://www.cgal.org/)'s `Straight_skeleton_2` package compiled to
WebAssembly.

This is a from-scratch rebuild of the idea behind
[`StrandedKitty/straight-skeleton`](https://github.com/StrandedKitty/straight-skeleton),
using **CGAL 6.1**, **Emscripten 4.x** (embind), and a modern ESM bundle.

## What it computes

The **straight skeleton** of a simple polygon (with optional holes): the set of
edges traced by the polygon's edges as they move inward at constant speed. Each
skeleton vertex carries a `time` value — the distance the wavefront travelled to
reach it — which doubles as a roof height.

str8 computes:

- **Interior** and **exterior** straight skeletons.
- **Offset contours** — inset (erode) or outset (dilate) a polygon by a
  distance, derived from the skeleton.

**[▶ Live demos](https://matthewjacobson.github.io/str8/)**

## Install

```sh
npm install @matthewjacobson/str8
```

The published package is a single ESM file with the WASM **embedded** (base64),
so there's nothing extra to host or configure.

## Usage

```ts
import { init, buildFromPolygon } from '@matthewjacobson/str8';

await init(); // load the WASM module once

const skeleton = buildFromPolygon([
  // outer ring (winding order doesn't matter — it's normalized for you)
  [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  // optional holes follow...
]);

if (skeleton) {
  // vertices: flat Float32Array of [x, y, time] triples
  for (let i = 0; i < skeleton.vertices.length; i += 3) {
    const [x, y, time] = skeleton.vertices.subarray(i, i + 3);
  }
  // faces: one entry per skeleton face, each a list of vertex indices
  for (const face of skeleton.faces) {
    // face = [i0, i1, i2, ...] indices into vertices
  }
}
```

### GeoJSON

```ts
import { init, buildFromGeoJSON } from '@matthewjacobson/str8';

await init();
const results = buildFromGeoJSON({
  type: 'Polygon',
  coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4]]],
});
// results: (Skeleton | null)[] — one per polygon (MultiPolygon supported)
```

## API

| Export | Description |
| --- | --- |
| `init(): Promise<void>` | Loads and instantiates the WASM module. Await once before building. |
| `isReady(): boolean` | Whether the module is loaded. |
| `buildFromPolygon(rings, opts?): Skeleton \| null` | Interior skeleton of a polygon. Ring 0 is the outer boundary; the rest are holes. |
| `buildFromGeoJSON(geometry, opts?): (Skeleton \| null)[]` | Interior skeletons from a GeoJSON `Polygon` / `MultiPolygon`. |
| `buildExteriorSkeleton(rings, { maxOffset }): Skeleton \| null` | Exterior skeleton, framed `maxOffset` beyond the polygon. |
| `offsetPolygon(rings, distances, opts?): OffsetResult \| null` | Inset (default) or outset (`{ exterior: true }`) offset contours for each distance, plus the shared skeleton. |

```ts
interface Skeleton {
  vertices: Float32Array; // [x, y, time, ...]
  faces: number[][];      // vertex indices, one list per face
}

interface OffsetPolygon {
  outer: Float32Array;    // [x, y, ...]
  holes: Float32Array[];  // each [x, y, ...]
}

interface OffsetResult {
  skeleton: Skeleton;        // the skeleton the offsets were derived from
  contours: OffsetPolygon[][]; // contours[i] is the offset at distances[i]
}
```

`offsetPolygon` takes an **array of distances** and builds the straight skeleton
**once**, then derives every offset from it. Recomputing the skeleton per
distance is the dominant cost — for concentric contours, passing all distances
together is several times faster than one call per distance (≈5× for eight
rings). The skeleton is returned alongside the contours, so you can draw it for
free.

An inset can split into several pieces or vanish past the polygon's max
inradius, so each distance's entry in `contours` is an *array* of contours
(possibly empty). `contours[i]` corresponds to `distances[i]`. All builders
accept `{ forceExact: true }` to skip the fast kernel (see below).

```ts
const { skeleton, contours } = offsetPolygon(rings, [10, 20, 30]);
// contours[0] = inset by 10, contours[1] = by 20, contours[2] = by 30
```

### Input handling (modernizations over the original)

- **Winding order is normalized automatically** — outer ring forced CCW, holes
  CW. You don't have to pre-orient your data.
- **Open or closed rings both work** — a duplicated closing vertex is dropped.
- **Near-collinear vertices are dropped** — see below.
- Degenerate input (fewer than 3 vertices, empty) returns `null` instead of
  aborting the WASM module.

### Near-collinear vertices

A vertex that sits almost exactly on the straight line through its two
neighbours (an interior angle of ≈180°) has an effectively undefined angle
bisector. The straight skeleton is built by advancing each vertex along that
bisector, so such a vertex derails CGAL's event scheduling and the build fails
outright — returning `null` even though the polygon looks fine.

These vertices are common in real data: an axis-aligned edge whose midpoint
reads `7511.999999999998` instead of `7512` (floating-point noise of ~1e-12)
introduces an almost-straight corner. str8 removes them up front — any vertex
whose perpendicular distance to the line through its neighbours is below a small
epsilon (`1e-6`) is dropped before the geometry reaches CGAL. Genuine polygon
features sit far above this threshold, so only redundant near-straight points
are removed. This runs on every build path.

### Validation: touching rings

CGAL's `Straight_skeleton_2` requires a polygon's holes to be **pairwise
disjoint** and to not touch the outer boundary. Rings that meet — even at a
single point — form a non-simple arrangement that fails deep inside CGAL with no
useful diagnostic.

str8 checks for this before building and **throws** a descriptive error naming
the offending rings and the shared point, rather than returning a bare `null`:

```
str8: hole 4 and hole 5 touch at vertex (7273, 7314.5); rings must be pairwise
disjoint — holes may not touch each other or the outer boundary.
```

The check runs for interior builds (`buildFromPolygon`, `buildFromGeoJSON`, and
interior `offsetPolygon`). It is skipped for the exterior skeleton and exterior
offset, which use only the outer boundary, so holes there are irrelevant.

#### Auto-separating touching rings

If you'd rather build than be rejected, pass `{ separateTouchingHoles: true }`.
Instead of throwing, str8 nudges each hole's copy of a shared vertex a hair into
that hole's interior — along the interior angle bisector, by ~1% of the shorter
incident edge — so the rings become disjoint and the skeleton builds. The outer
boundary is never moved; only holes retreat from it.

```ts
// the polygon's holes touch at a shared vertex
buildFromPolygon(rings, { separateTouchingHoles: true });
buildFromGeoJSON(geometry, { separateTouchingHoles: true });
```

This is a cheap, pure-JS pre-pass (no WASM cost) and perturbs the geometry only
by a sub-percent of the local edge length. Like the validation it replaces, it
acts on **coincident-vertex** touches only — not the vertex-on-edge or
overlapping-edge cases below.

**Limitation — only coincident vertices are detected.** The check flags two
rings that share an identical vertex, which is by far the most common cause (for
example, a shape sliced into pieces that reuse boundary coordinates). It does
**not** detect:

- **vertex-on-edge** touches — a vertex of one ring lying partway along an edge
  of another, without being one of that edge's endpoints, and
- **overlapping-edge** touches — two rings that share a length of edge rather
  than a single point.

These cases will still reach CGAL and typically surface as a `null` result.
Detecting them reliably requires an `O(V·E)` edge-intersection pass, which str8
does not currently perform.

### Robustness: automatic exact fallback

CGAL's straight skeleton uses the fast **inexact-constructions** kernel (EPICK)
by default. Highly symmetric inputs — e.g. a grid of identical, evenly-spaced
holes — create many *simultaneous* wavefront events that EPICK's rounded
arithmetic can't resolve consistently, and the computation fails.

str8 handles this automatically: if the fast kernel fails, it retries with the
**exact-constructions** kernel (EPECK), which is slower but robust. You normally
don't have to think about it. To skip the fast attempt and go straight to exact:

```ts
buildFromPolygon(rings, { forceExact: true });
buildFromGeoJSON(geometry, { forceExact: true });
```

## Building from source

Requires the [Emscripten SDK](https://emscripten.org/) and CGAL + Boost headers
(e.g. `brew install cgal boost` on macOS).

```sh
# 1. compile the CGAL core to a single-file ES module (src/core/skeleton.js)
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm

# 2. bundle the TS wrapper + emit types -> dist/
npm run build

# or both at once:
npm run build:all
```

If your headers aren't in `/opt/homebrew/include`, set `DEPS_INCLUDE_DIR`:

```sh
DEPS_INCLUDE_DIR=/usr/local/include npm run build:wasm
```

## Examples

Static demos live in `example/` — serve the repo root over HTTP (e.g.
`npx serve` or `python3 -m http.server`) and open them:

- `example/index.html` — a **gallery** with a dropdown of 28 sample polygons
  (from [`LingDong-/interesting-polygon-archive`](https://github.com/LingDong-/interesting-polygon-archive)),
  with pan, zoom, and live vertex/hole/face stats.
- `example/geojson.html` — **paste your own GeoJSON** (`Polygon`,
  `MultiPolygon`, `Feature`, `FeatureCollection`, or a bare coordinates array)
  and see its skeleton, with pan/zoom and a Y-flip toggle for
  screen-coordinate data.
- `example/roof.html` — **3D straight-skeleton roofs**: the same sample
  polygons lifted into roofs where each vertex's height is its wavefront
  `time`, rendered with [three.js](https://threejs.org/) (orbit, adjustable
  pitch). three.js is loaded from a CDN, so this page needs network access.
- `example/offset.html` — **offsets**: interior/exterior inset/outset offset
  contours (with concentric stepping), driven by a distance slider, with a
  "show skeleton" toggle that overlays the skeleton the offsets were derived
  from, and pan/zoom.
- `example/pathfind.html` — **central paths**: drag two points and route a
  path between them through the polygon's center along the skeleton, with a
  direct↔central dial and smoothing. Like the region demo, this consumes the
  [**str8-path**](https://github.com/matthewjacobson/str8-path) package
  (`PathFinder`), loading str8 + JSTS from a CDN at runtime.
- `example/region.html` — **region-to-region paths**: connect two draggable
  sub-regions inside a container, boundary-to-boundary through the container's
  central skeleton. This demo consumes the separate
  [**str8-path**](https://github.com/matthewjacobson/str8-path) package
  (`PathFinder`), which builds on str8 + JSTS — so it loads those from a CDN at
  runtime.

They import the built `dist/str8.js`, so run `npm run build` first.

## How it works

- `src/core/skeleton.cpp` — CGAL `create_interior_straight_skeleton_2` over a
  `Polygon_with_holes_2` (EPICK kernel), exposed via **embind**. Returns a
  `Float32Array` of vertices and a `number[][]` of faces directly as JS objects.
- Built with `-sMODULARIZE -sEXPORT_ES6 -sSINGLE_FILE` so the WASM is embedded
  in an ES module. GMP/MPFR are disabled (`CGAL_DISABLE_GMP`) so nothing native
  needs cross-compiling.
- `src/index.ts` — the public API: orientation normalization, GeoJSON helpers,
  and the WASM lifecycle.

## License

MIT. CGAL is used under its own license (GPL/LGPL depending on package);
`Straight_skeleton_2` is GPL — review CGAL's licensing for your use case.
