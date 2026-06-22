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
 * @throws If two rings touch (a hole touching another hole or the outer
 *   boundary), since CGAL requires the holes to be pairwise disjoint.
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
export declare function offsetPolygon(rings: Rings, distance: number, options?: OffsetOptions): OffsetPolygon[] | null;
