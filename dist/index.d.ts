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
