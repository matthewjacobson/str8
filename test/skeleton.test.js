import { test } from 'node:test';
import assert from 'node:assert/strict';

import { init, isReady, buildFromPolygon, buildFromGeoJSON } from '../dist/str8.js';

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
