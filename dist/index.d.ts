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
/**
 * Load and instantiate the WebAssembly module. Must be awaited once before any
 * `build*` call. Safe to call repeatedly; subsequent calls reuse the instance.
 */
export declare function init(): Promise<void>;
/** Whether the WASM module has finished loading. */
export declare function isReady(): boolean;
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
export declare function buildFromPolygon(rings: Rings, options?: BuildOptions): Skeleton | null;
/**
 * Build skeletons from a GeoJSON `Polygon` or `MultiPolygon` geometry.
 *
 * For a `Polygon` the result array has one entry; for a `MultiPolygon` it has
 * one entry per polygon. Entries are `null` where that polygon failed.
 */
export declare function buildFromGeoJSON(geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
}, options?: BuildOptions): (Skeleton | null)[];
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
export declare function buildExteriorSkeleton(rings: Rings, options: ExteriorSkeletonOptions): Skeleton | null;
/** A single offset contour: an outer ring and its holes, each a flat `[x, y, ...]` array. */
export interface OffsetPolygon {
    outer: Float32Array;
    holes: Float32Array[];
}
/** The result of {@link offsetPolygon}: the shared skeleton plus per-distance contours. */
export interface OffsetResult {
    /**
     * The straight skeleton the offsets were derived from (interior, or — with
     * `{ exterior: true }` — exterior). Computed once and shared by every
     * distance, so it's returned for free if you also want to draw it.
     */
    skeleton: Skeleton;
    /**
     * One contour set per requested distance: `contours[i]` holds the offset
     * polygons at `distances[i]`. A set may be empty (the offset eroded to
     * nothing, or grew past the frame).
     */
    contours: OffsetPolygon[][];
}
export interface OffsetOptions extends BuildOptions {
    /**
     * `false` (default) insets the polygon inward; `true` outsets it (the
     * exterior offset), growing outward from the outer boundary.
     */
    exterior?: boolean;
}
/**
 * Offset (inset or outset) a polygon by each of several `distances`, via the
 * straight skeleton.
 *
 * The skeleton is built **once** and reused for every distance — recomputing it
 * per distance (e.g. for concentric contours) is the dominant cost, so passing
 * all distances together is far faster than calling once per distance.
 *
 * An inset can split into several disjoint pieces (or vanish entirely past the
 * polygon's max inradius), so each distance's result is an *array* of `{ outer,
 * holes }` contours (possibly empty). The shared skeleton is returned too.
 *
 * @param distances How far to offset, one or more values. Each must be > 0.
 * @returns `{ skeleton, contours }` where `contours[i]` matches `distances[i]`,
 *   or `null` if the input is degenerate or CGAL fails.
 */
export declare function offsetPolygon(rings: Rings, distances: number[], options?: OffsetOptions): OffsetResult | null;
