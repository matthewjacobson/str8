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
| `offsetPolygon(rings, distance, opts?): OffsetPolygon[] \| null` | Inset (default) or outset (`{ exterior: true }`) offset contours. |

```ts
interface Skeleton {
  vertices: Float32Array; // [x, y, time, ...]
  faces: number[][];      // vertex indices, one list per face
}

interface OffsetPolygon {
  outer: Float32Array;    // [x, y, ...]
  holes: Float32Array[];  // each [x, y, ...]
}
```

An inset can split into several pieces or vanish past the polygon's max
inradius, so `offsetPolygon` returns an *array* of contours (possibly empty).
All builders accept `{ forceExact: true }` to skip the fast kernel (see below).

### Input handling (modernizations over the original)

- **Winding order is normalized automatically** — outer ring forced CCW, holes
  CW. You don't have to pre-orient your data.
- **Open or closed rings both work** — a duplicated closing vertex is dropped.
- Degenerate input (fewer than 3 vertices, empty) returns `null` instead of
  aborting the WASM module.

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
- `example/offset.html` — **offsets & exterior skeletons**: inset/outset
  offset contours (with concentric stepping) and interior/exterior straight
  skeletons, driven by a distance slider, with pan/zoom.
- `example/pathfind.html` — **central paths**: click two points and route a
  path between them through the polygon's center along the skeleton, with a
  direct↔central dial (clearance-bounded string-pulling) and clearance-safe
  smoothing. Pure JS (`example/pathfind.js`) over the skeleton output.
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
