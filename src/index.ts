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
 * Normalize one polygon's rings into the flat buffers the WASM core expects:
 * open rings, outer counter-clockwise, holes clockwise.
 */
function flatten(rings: Rings): { coords: number[]; sizes: number[] } | null {
  if (rings.length === 0) return null;

  const coords: number[] = [];
  const sizes: number[] = [];

  rings.forEach((rawRing, index) => {
    const ring = open(rawRing);
    if (ring.length < 3) return;

    const isOuter = index === 0;
    const ccw = signedArea2(ring) > 0;
    // Outer must be CCW, holes must be CW.
    const reverse = isOuter ? !ccw : ccw;
    const ordered = reverse ? ring.slice().reverse() : ring;

    for (const [x, y] of ordered) {
      coords.push(x, y);
    }
    sizes.push(ordered.length);
  });

  if (sizes.length === 0 || sizes[0] < 3) return null;
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
 */
export function buildFromPolygon(rings: Rings, options: BuildOptions = {}): Skeleton | null {
  const m = ensureReady();
  const flat = flatten(rings);
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
  const flat = flatten(rings);
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
  const flat = flatten(rings);
  if (!flat) return null;
  return m.offsetPolygons(
    flat.coords,
    flat.sizes,
    distance,
    options.exterior ?? false,
    options.forceExact ?? false,
  );
}
