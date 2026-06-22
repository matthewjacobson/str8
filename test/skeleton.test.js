import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  init,
  isReady,
  buildFromPolygon,
  buildFromGeoJSON,
  buildExteriorSkeleton,
  offsetPolygon,
} from '../dist/str8.js';

const SQUARE = [
  [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ],
];

test('init resolves and isReady flips', async () => {
  assert.equal(isReady(), false);
  await init();
  assert.equal(isReady(), true);
});

test('square produces a center vertex and four faces', async () => {
  await init();
  const result = buildFromPolygon([
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  ]);

  assert.ok(result, 'expected a skeleton');
  assert.ok(result.vertices instanceof Float32Array);
  // A square skeleton: 4 corners + 1 center node.
  assert.equal(result.vertices.length / 3, 5);
  assert.equal(result.faces.length, 4);

  // The interior node sits at the origin with time 1 (distance to each edge).
  const triples = [];
  for (let i = 0; i < result.vertices.length; i += 3) {
    triples.push([result.vertices[i], result.vertices[i + 1], result.vertices[i + 2]]);
  }
  const center = triples.find((t) => Math.abs(t[2] - 1) < 1e-4);
  assert.ok(center, 'expected a node at time ~1');
  assert.ok(Math.abs(center[0]) < 1e-4 && Math.abs(center[1]) < 1e-4, 'center at origin');
});

test('clockwise outer ring is auto-normalized', async () => {
  await init();
  const ccw = buildFromPolygon([
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  ]);
  const cw = buildFromPolygon([
    [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ],
  ]);
  assert.ok(ccw && cw);
  assert.equal(ccw.vertices.length, cw.vertices.length);
  assert.equal(ccw.faces.length, cw.faces.length);
});

test('explicitly closed rings (duplicate last vertex) are accepted', async () => {
  await init();
  const result = buildFromPolygon([
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0], // closing vertex
    ],
  ]);
  assert.ok(result);
  assert.equal(result.faces.length, 4);
});

test('polygon with a hole yields more faces than without', async () => {
  await init();
  const outer = [
    [-4, -4],
    [4, -4],
    [4, 4],
    [-4, 4],
  ];
  const hole = [
    [-1, -1],
    [-1, 1],
    [1, 1],
    [1, -1],
  ];
  const withHole = buildFromPolygon([outer, hole]);
  assert.ok(withHole);
  assert.ok(withHole.faces.length >= 8, `expected >=8 faces, got ${withHole.faces.length}`);
});

// Regression: highly symmetric polygons with many evenly-spaced identical
// holes create simultaneous wavefront events that the inexact-constructions
// kernel can't resolve. str8 must auto-fall back to the exact kernel.
test('symmetric multi-hole polygon succeeds via exact fallback', async () => {
  await init();
  const circle = (cx, cy, r, n = 20) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });

  const rings = [
    [[50, 50], [350, 50], [350, 350], [50, 350]], // outer square
    circle(125, 125, 55),
    circle(275, 275, 55),
    circle(125, 275, 55),
    circle(275, 125, 55),
    circle(200, 200, 35),
  ];

  // Auto mode (inexact first, exact fallback).
  const auto = buildFromPolygon(rings);
  assert.ok(auto, 'expected a skeleton from auto fallback');
  assert.ok(auto.faces.length > 50);

  // Forcing exact should give the same face count.
  const exact = buildFromPolygon(rings, { forceExact: true });
  assert.ok(exact);
  assert.equal(auto.faces.length, exact.faces.length);
});

test('degenerate input returns null', async () => {
  await init();
  assert.equal(buildFromPolygon([]), null);
  assert.equal(buildFromPolygon([[[0, 0], [1, 1]]]), null); // < 3 vertices
});

// A near-collinear (~180°) vertex — here a midpoint nudged by float noise off
// an axis-aligned edge — has an ill-defined bisector and breaks CGAL. flatten()
// must drop it so the build still succeeds.
test('near-collinear vertices are sanitized away', async () => {
  await init();
  const bad = buildFromPolygon([
    [
      [0, 0],
      [100, 0],
      [100.000000001, 50], // nudged just off the 100,0 -> 100,100 edge
      [100, 100],
      [0, 100],
    ],
  ]);
  assert.ok(bad, 'expected the near-collinear vertex to be dropped and the build to succeed');
  // Same skeleton as the clean square: 4 corners + 1 center.
  assert.equal(bad.vertices.length / 3, 5);
  assert.equal(bad.faces.length, 4);
});

// Holes must be pairwise disjoint; two holes sharing a vertex form an invalid
// arrangement that fails opaquely inside CGAL. flatten() detects it and throws
// a descriptive error naming the offending rings.
test('touching holes throw with a descriptive error', async () => {
  await init();
  const rings = [
    [[0, 0], [100, 0], [100, 100], [0, 100]],
    [[20, 20], [40, 20], [30, 40]], // shares vertex (40, 20) with the next hole
    [[40, 20], [60, 20], [50, 40]],
  ];
  assert.throws(() => buildFromPolygon(rings), /hole 1 and hole 2 touch at vertex \(40, 20\)/);

  // A hole sharing a vertex with the outer boundary is reported too.
  const onBoundary = [
    [[0, 0], [100, 0], [100, 100], [0, 100]],
    [[0, 0], [20, 5], [5, 20]], // shares the outer corner (0, 0)
  ];
  assert.throws(() => buildFromPolygon(onBoundary), /the outer boundary and hole 1 touch/);
});

test('buildFromGeoJSON handles Polygon and MultiPolygon', async () => {
  await init();
  const poly = buildFromGeoJSON({
    type: 'Polygon',
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]],
  });
  assert.equal(poly.length, 1);
  assert.ok(poly[0]);

  const multi = buildFromGeoJSON({
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [2, 0], [2, 2], [0, 2]]],
      [[[10, 10], [12, 10], [12, 12], [10, 12]]],
    ],
  });
  assert.equal(multi.length, 2);
  assert.ok(multi[0] && multi[1]);
});

test('buildExteriorSkeleton frames the polygon and produces faces', async () => {
  await init();
  const ext = buildExteriorSkeleton(SQUARE, { maxOffset: 40 });
  assert.ok(ext, 'expected an exterior skeleton');
  assert.ok(ext.faces.length >= 4);
  // The bounding frame sits ~maxOffset beyond the square (200x200 footprint).
  let maxTime = 0;
  for (let i = 2; i < ext.vertices.length; i += 3) maxTime = Math.max(maxTime, ext.vertices[i]);
  assert.ok(maxTime > 0);
});

test('buildExteriorSkeleton requires a positive maxOffset', async () => {
  await init();
  assert.throws(() => buildExteriorSkeleton(SQUARE, { maxOffset: 0 }));
});

test('interior offset insets, and erodes to nothing past the inradius', async () => {
  await init();
  const inset = offsetPolygon(SQUARE, 20); // inradius is 50
  assert.ok(inset);
  assert.equal(inset.length, 1);
  assert.equal(inset[0].outer.length / 2, 4); // still a quad
  assert.equal(inset[0].holes.length, 0);

  // Inset of an 80x80 inner square should be ~60x60: spans 20..80.
  const xs = [];
  for (let i = 0; i < inset[0].outer.length; i += 2) xs.push(inset[0].outer[i]);
  assert.ok(Math.min(...xs) > 15 && Math.max(...xs) < 85);

  const eroded = offsetPolygon(SQUARE, 60);
  assert.ok(eroded);
  assert.equal(eroded.length, 0); // fully collapsed
});

test('interior offset of a polygon with a hole grows the hole', async () => {
  await init();
  const withHole = [
    [[0, 0], [100, 0], [100, 100], [0, 100]],
    [[40, 40], [40, 60], [60, 60], [60, 40]],
  ];
  const inset = offsetPolygon(withHole, 8);
  assert.ok(inset);
  assert.equal(inset.length, 1);
  assert.equal(inset[0].holes.length, 1);
});

test('exterior offset outsets the boundary', async () => {
  await init();
  const out = offsetPolygon(SQUARE, 20, { exterior: true });
  assert.ok(out);
  assert.ok(out.length >= 1);
  // The outset contour should extend beyond the original [0,100] bounds.
  const xs = [];
  for (let i = 0; i < out[0].outer.length; i += 2) xs.push(out[0].outer[i]);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 100);
});

test('offsetPolygon requires a positive distance', async () => {
  await init();
  assert.throws(() => offsetPolygon(SQUARE, 0));
});

// ---------------------------------------------------------------------------
// separateTouchingHoles: nudge holes that share a vertex apart so they become
// disjoint and the skeleton can build, instead of rejecting the input.
// ---------------------------------------------------------------------------

const SEP_OUTER = [[0, 0], [100, 0], [100, 100], [0, 100]];

// Classify a build outcome without letting a WASM-level throw abort the runner.
function buildOutcome(rings, opts) {
  try {
    return buildFromPolygon(rings, opts) ? 'ok' : 'null';
  } catch {
    return 'throw';
  }
}

test('separateTouchingHoles nudges shared-vertex holes apart so the build succeeds', async () => {
  await init();
  // Two triangles meeting only at the point (40, 20).
  const rings = [
    SEP_OUTER,
    [[20, 20], [40, 20], [30, 40]],
    [[40, 20], [60, 20], [50, 40]],
  ];
  assert.throws(() => buildFromPolygon(rings), /touch at vertex \(40, 20\)/); // default rejects it
  const sep = buildFromPolygon(rings, { separateTouchingHoles: true });
  assert.ok(sep, 'expected the perturbation to make the holes disjoint');
  assert.ok(sep.faces.length > 0);
});

test('separateTouchingHoles also separates a hole touching the outer boundary', async () => {
  await init();
  const rings = [
    SEP_OUTER,
    [[0, 0], [20, 5], [5, 20]], // shares the outer corner (0, 0)
  ];
  assert.throws(() => buildFromPolygon(rings));
  assert.ok(buildFromPolygon(rings, { separateTouchingHoles: true }));
});

test('separateTouchingHoles does not address overlapping-area holes', async () => {
  await init();
  // Two holes whose areas overlap (no single shared vertex to move): there is
  // nothing for the vertex nudge to separate, so this stays unbuildable.
  const rings = [
    SEP_OUTER,
    [[20, 20], [50, 20], [50, 40], [20, 40]],
    [[30, 40], [60, 40], [60, 60], [30, 60]],
  ];
  assert.equal(buildOutcome(rings, { separateTouchingHoles: true }), 'null');
});

test('separateTouchingHoles builds the real edge-case GeoJSON', async () => {
  await init();
  const geo = JSON.parse(readFileSync(new URL('../example/edgeCaseGeoJson.json', import.meta.url)));
  // The file's defect is two holes sharing a vertex.
  assert.throws(() => buildFromPolygon(geo.coordinates)); // default: detected + rejected
  const sep = buildFromPolygon(geo.coordinates, { separateTouchingHoles: true });
  assert.ok(sep, 'expected the perturbation to resolve the shared vertex');
  assert.ok(sep.faces.length > 100);
});
