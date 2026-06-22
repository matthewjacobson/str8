/**
 * str8 — a modern straight-skeleton library.
 *
 * Computes the interior straight skeleton of a simple polygon (with optional
 * holes) using CGAL's `Straight_skeleton_2`, compiled to WebAssembly.
 *
 * ```ts
 * import { init, buildFromPolygon } from 'str8';
 *
 * await init();
 * const result = buildFromPolygon([
 *   [[-1, -1], [1, -1], [1, 1], [-1, 1]], // outer ring
 * ]);
 * // result?.vertices : Float32Array of [x, y, time] triples
 * // result?.faces    : number[][] of vertex indices, one entry per skeleton face
 * ```
 */
import createSkeletonModule, { type SkeletonModule } from './core/skeleton.js';

/** A 2D point as `[x, y]`. */
export type Point = [number, number];

/**
 * A polygon as an array of rings. The first ring is the outer boundary; any
 * remaining rings are holes. Rings may be open or closed (a repeated final
 * vertex is fine) and may use either winding order — both are normalized
 * automatically. This matches the GeoJSON polygon coordinate layout.
 */
export type Rings = Point[][];

export interface Skeleton {
  /** Flat `[x, y, time, ...]` triples; `time` is the wavefront distance. */
  vertices: Float32Array;
  /** One entry per skeleton face: a list of vertex indices into `vertices`. */
  faces: number[][];
}

export interface BuildOptions {
  /**
   * Skip the fast inexact-constructions kernel and build directly with the
   * exact kernel. Slower, but the most robust. By default str8 tries the fast
   * kernel first and only falls back to exact if it fails, so you rarely need
   * this — set it if you want deterministic exact results up front.
   */
  forceExact?: boolean;

  /**
   * Instead of rejecting holes that touch at a shared vertex, nudge them apart
   * a hair so they become disjoint and the skeleton can build. This is a
   * cheap, pure-JS pre-pass that resolves the common case — holes (or a hole
   * and the outer boundary) meeting at a coincident vertex, e.g. a shape
   * sliced into pieces that reuse boundary coordinates.
   *
   * The nudge perturbs geometry by ~1% of the shorter incident edge near each
   * touch. It handles *vertex* coincidences only; a vertex lying partway along
   * another ring's edge (vertex-on-edge) is not addressed.
   */
  separateTouchingHoles?: boolean;
}

let modulePromise: Promise<SkeletonModule> | null = null;
let mod: SkeletonModule | null = null;

/**
 * Load and instantiate the WebAssembly module. Must be awaited once before any
 * `build*` call. Safe to call repeatedly; subsequent calls reuse the instance.
 */
export async function init(): Promise<void> {
  if (!modulePromise) {
    modulePromise = createSkeletonModule();
  }
  mod = await modulePromise;
}

/** Whether the WASM module has finished loading. */
export function isReady(): boolean {
  return mod !== null;
}

/** Signed area × 2 of a ring (positive = counter-clockwise). */
function signedArea2(ring: Point[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** Drop a duplicated closing vertex if the ring is explicitly closed. */
function open(ring: Point[]): Point[] {
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

/**
 * Largest perpendicular distance below which a vertex is treated as lying on
 * the line through its neighbours. Real polygon features sit far above this;
 * the targets are float-noise artifacts (e.g. an axis-aligned edge whose
 * midpoint reads `7511.999999999998` instead of `7512`), which are ~1e-12 off.
 */
const COLLINEAR_EPS = 1e-6;

/** Perpendicular distance from `p` to the infinite line through `a` and `c`. */
function lineDistance(p: Point, a: Point, c: Point): number {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/**
 * Drop near-collinear (≈180°) vertices from an open ring. Such vertices have
 * an ill-defined angle bisector, which destabilizes CGAL's straight-skeleton
 * event scheduling and makes the build fail outright. Removing them is exact
 * for a truly collinear point and a sub-`COLLINEAR_EPS` nudge otherwise.
 *
 * Iterates until stable, since removing one vertex can leave a neighbour
 * collinear. Never drops below a triangle (degenerate rings are caught later).
 */
function dropCollinearVertices(ring: Point[]): Point[] {
  let out = ring;
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i - 1 + out.length) % out.length];
      const next = out[(i + 1) % out.length];
      if (lineDistance(out[i], prev, next) < COLLINEAR_EPS) {
        out = out.slice(0, i).concat(out.slice(i + 1));
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Human label for a ring in diagnostics: index 0 is the outer boundary. */
function ringName(index: number): string {
  return index === 0 ? 'the outer boundary' : `hole ${index}`;
}

/**
 * Fail early on touching rings. CGAL's `Straight_skeleton_2` requires the holes
 * of a polygon to be pairwise disjoint and not touch the outer boundary; two
 * rings meeting even at a single point form an invalid (non-simple) arrangement
 * that fails opaquely deep inside CGAL. The common case is a shared vertex
 * (e.g. a shape sliced into pieces that reuse boundary coordinates), which this
 * catches by exact coincidence. `cleaned` carries each ring's original input
 * index so the message points at the right ring.
 */
function detectTouchingRings(cleaned: { ring: Point[]; index: number }[]): void {
  const seen = new Map<string, number>(); // "x,y" -> original ring index
  for (const { ring, index } of cleaned) {
    for (const [x, y] of ring) {
      const key = `${x},${y}`;
      const prev = seen.get(key);
      if (prev !== undefined && prev !== index) {
        throw new Error(
          `str8: ${ringName(prev)} and ${ringName(index)} touch at vertex ` +
            `(${x}, ${y}); rings must be pairwise disjoint — holes may not touch ` +
            `each other or the outer boundary.`,
        );
      }
      if (prev === undefined) seen.set(key, index);
    }
  }
}

function unit(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  return len === 0 ? [0, 0] : [x / len, y / len];
}

/** Ray-cast point-in-polygon test against an (open) ring. */
function pointInRing(px: number, py: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Nudge vertex `i` of `ring` a small step into the ring's own interior, along
 * the interior angle bisector at that vertex. For a hole (whose interior is the
 * void), this shrinks the hole slightly, pulling the vertex off a touch point.
 * The step is scaled to the shorter incident edge so it never overshoots, and
 * its sign is chosen by an actual point-in-ring test (robust to winding and to
 * reflex vertices).
 */
function nudgeVertexInward(ring: Point[], i: number): void {
  const n = ring.length;
  const v = ring[i];
  const p = ring[(i - 1 + n) % n];
  const q = ring[(i + 1) % n];
  const u = unit(p[0] - v[0], p[1] - v[1]);
  const w = unit(q[0] - v[0], q[1] - v[1]);
  let bx = u[0] + w[0];
  let by = u[1] + w[1];
  let blen = Math.hypot(bx, by);
  if (blen < 1e-9) {
    // Edges nearly opposite: bisector is undefined, use a perpendicular.
    [bx, by] = [-u[1], u[0]];
    blen = Math.hypot(bx, by) || 1;
  }
  bx /= blen;
  by /= blen;
  const e = Math.min(Math.hypot(p[0] - v[0], p[1] - v[1]), Math.hypot(q[0] - v[0], q[1] - v[1]));
  const step = e * 0.01;
  // Pick the direction that lands inside the ring (the hole's void).
  const sign = pointInRing(v[0] + bx * step, v[1] + by * step, ring) ? 1 : -1;
  ring[i] = [v[0] + bx * step * sign, v[1] + by * step * sign];
}

/**
 * Pull apart rings that touch at a shared vertex, as an alternative to
 * rejecting them. Each hole's copy of a shared vertex is nudged into that
 * hole's interior (see {@link nudgeVertexInward}), opening a sliver of free
 * space at the pinch so the holes become disjoint. The outer boundary is never
 * moved — only the holes retreat from it. Like {@link detectTouchingRings},
 * this handles coincident-vertex touches (not vertex-on-edge contacts).
 */
function separateTouchingRings(cleaned: { ring: Point[]; index: number }[]): void {
  // Group every occurrence of each coordinate across all rings.
  const byKey = new Map<string, { ci: number; vi: number }[]>();
  cleaned.forEach(({ ring }, ci) => {
    ring.forEach(([x, y], vi) => {
      const key = `${x},${y}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ ci, vi });
    });
  });

  for (const refs of byKey.values()) {
    // Shared only if it appears in two or more distinct rings.
    if (new Set(refs.map((r) => r.ci)).size < 2) continue;
    for (const { ci, vi } of refs) {
      if (cleaned[ci].index === 0) continue; // keep the outer boundary fixed
      nudgeVertexInward(cleaned[ci].ring, vi);
    }
  }
}

/** How {@link flatten} treats rings that touch at a shared vertex. */
type TouchMode = 'throw' | 'separate' | 'ignore';

/**
 * Normalize one polygon's rings into the flat buffers the WASM core expects:
 * open rings, near-collinear vertices dropped, outer counter-clockwise, holes
 * clockwise.
 *
 * @param touch How to handle rings that touch at a shared vertex: `'throw'`
 *   rejects them (see {@link detectTouchingRings}); `'separate'` nudges them
 *   apart (see {@link separateTouchingRings}); `'ignore'` leaves them (used
 *   where holes don't matter, e.g. the exterior skeleton/offset).
 */
function flatten(
  rings: Rings,
  touch: TouchMode,
): { coords: number[]; sizes: number[] } | null {
  if (rings.length === 0) return null;

  // Open + sanitize each ring up front, keeping its original index so any
  // touching-ring diagnostic refers to the caller's layout.
  const cleaned: { ring: Point[]; index: number }[] = [];
  rings.forEach((rawRing, index) => {
    const ring = dropCollinearVertices(open(rawRing));
    if (ring.length < 3) return; // degenerate ring (incl. a collapsed outer)
    cleaned.push({ ring, index });
  });

  // Need a usable outer boundary as the first ring.
  if (cleaned.length === 0 || cleaned[0].index !== 0) return null;

  if (touch === 'throw') detectTouchingRings(cleaned);
  else if (touch === 'separate') separateTouchingRings(cleaned);

  const coords: number[] = [];
  const sizes: number[] = [];
  for (const { ring, index } of cleaned) {
    const isOuter = index === 0;
    const ccw = signedArea2(ring) > 0;
    // Outer must be CCW, holes must be CW.
    const reverse = isOuter ? !ccw : ccw;
    const ordered = reverse ? ring.slice().reverse() : ring;

    for (const [x, y] of ordered) {
      coords.push(x, y);
    }
    sizes.push(ordered.length);
  }

  return { coords, sizes };
}

function ensureReady(): SkeletonModule {
  if (!mod) {
    throw new Error('str8: call `await init()` before building skeletons.');
  }
  return mod;
}

/**
 * Build the interior straight skeleton of a polygon.
 *
 * For hard inputs (e.g. highly symmetric polygons with many simultaneous
 * wavefront events) str8 automatically retries with an exact-constructions
 * kernel, so you generally don't need {@link BuildOptions.forceExact}.
 *
 * @param rings   Outer ring first, then holes. See {@link Rings}.
 * @param options Optional build flags. See {@link BuildOptions}.
 * @returns The skeleton, or `null` if the input is degenerate or CGAL fails.
 * @throws If two rings touch at a shared vertex (a hole touching another hole
 *   or the outer boundary) — unless {@link BuildOptions.separateTouchingHoles}
 *   is set, in which case the touch is nudged apart instead of rejected.
 */
export function buildFromPolygon(rings: Rings, options: BuildOptions = {}): Skeleton | null {
  const m = ensureReady();
  // Nudge shared-vertex touches apart if asked, else fail early with a clear error.
  const touch: TouchMode = options.separateTouchingHoles ? 'separate' : 'throw';
  const flat = flatten(rings, touch);
  if (!flat) return null;
  return m.buildInteriorSkeleton(flat.coords, flat.sizes, options.forceExact ?? false);
}

/**
 * Build skeletons from a GeoJSON `Polygon` or `MultiPolygon` geometry.
 *
 * For a `Polygon` the result array has one entry; for a `MultiPolygon` it has
 * one entry per polygon. Entries are `null` where that polygon failed.
 */
export function buildFromGeoJSON(
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  },
  options: BuildOptions = {},
): (Skeleton | null)[] {
  if (geometry.type === 'Polygon') {
    return [buildFromPolygon(geometry.coordinates as Rings, options)];
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).map((poly) =>
      buildFromPolygon(poly as Rings, options),
    );
  }
  throw new Error(`str8: unsupported GeoJSON geometry type "${(geometry as { type: string }).type}".`);
}

export interface ExteriorSkeletonOptions extends BuildOptions {
  /**
   * The exterior straight skeleton is unbounded, so CGAL frames it with a
   * bounding box at this distance beyond the polygon. Must be > 0. Vertices
   * on the frame have `time` ≈ `maxOffset`.
   */
  maxOffset: number;
}

/**
 * Build the *exterior* straight skeleton of a polygon — the skeleton of the
 * unbounded region outside the outer boundary, framed at `options.maxOffset`.
 * Holes are ignored (only the outer boundary matters outside).
 *
 * @returns The skeleton, or `null` on degenerate input / CGAL failure.
 */
export function buildExteriorSkeleton(rings: Rings, options: ExteriorSkeletonOptions): Skeleton | null {
  const m = ensureReady();
  if (!(options.maxOffset > 0)) {
    throw new Error('str8: buildExteriorSkeleton requires options.maxOffset > 0.');
  }
  // The exterior skeleton uses only the outer boundary, so touching holes are
  // irrelevant here and must not fail the build.
  const flat = flatten(rings, 'ignore');
  if (!flat) return null;
  return m.buildExteriorSkeleton(flat.coords, flat.sizes, options.maxOffset, options.forceExact ?? false);
}

/** A single offset contour: an outer ring and its holes, each a flat `[x, y, ...]` array. */
export interface OffsetPolygon {
  outer: Float32Array;
  holes: Float32Array[];
}

export interface OffsetOptions extends BuildOptions {
  /**
   * `false` (default) insets the polygon inward; `true` outsets it (the
   * exterior offset), growing outward from the outer boundary.
   */
  exterior?: boolean;
}

/**
 * Offset (inset or outset) a polygon by `distance`, via the straight skeleton.
 *
 * An inset can split into several disjoint pieces (or vanish entirely past the
 * polygon's max inradius), so the result is an *array* of contours. Each
 * contour is an `{ outer, holes }` polygon.
 *
 * @param distance How far to offset. Must be > 0.
 * @returns The offset contours (possibly empty), or `null` on CGAL failure.
 */
export function offsetPolygon(
  rings: Rings,
  distance: number,
  options: OffsetOptions = {},
): OffsetPolygon[] | null {
  const m = ensureReady();
  if (!(distance > 0)) {
    throw new Error('str8: offsetPolygon requires distance > 0.');
  }
  // An interior offset consumes the holes (so touching holes are invalid); an
  // exterior offset only uses the outer boundary, so holes are irrelevant.
  const flat = flatten(rings, options.exterior ? 'ignore' : 'throw');
  if (!flat) return null;
  return m.offsetPolygons(
    flat.coords,
    flat.sizes,
    distance,
    options.exterior ?? false,
    options.forceExact ?? false,
  );
}
