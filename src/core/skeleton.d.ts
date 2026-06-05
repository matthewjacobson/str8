// Ambient declaration for the Emscripten-generated ES module (skeleton.js).
// Built by `npm run build:wasm`; not committed-friendly to type by hand, so we
// describe just the surface the wrapper uses.

export interface SkeletonModule {
  /**
   * @param rings     Flat coordinate buffer [x0,y0, x1,y1, ...] across all rings.
   * @param ringSizes Vertex count of each ring; [0] = outer (CCW), rest = holes (CW).
   * @returns { vertices: Float32Array; faces: number[][] } or null on failure.
   */
  buildInteriorSkeleton(
    rings: ArrayLike<number>,
    ringSizes: ArrayLike<number>,
    forceExact: boolean,
  ): { vertices: Float32Array; faces: number[][] } | null;
}

declare const createSkeletonModule: (
  moduleArg?: Record<string, unknown>,
) => Promise<SkeletonModule>;

export default createSkeletonModule;
