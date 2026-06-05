// SKETCH: "nice" central path between two points via the straight skeleton.
//
// Pure JS over str8's skeleton output ({ vertices:[x,y,time,...], faces:[[i..]] }).
// The skeleton is the polygon's spine and each vertex's `time` is its clearance
// (distance to the nearest wall), so routing along skeleton edges and penalizing
// low-clearance edges yields a path that travels through the "center".
//
// This is a prototype for iterating on the approach, not a polished API.

const EPS_TIME = 1e-6;

const dist2d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Extract the skeleton edge graph. Every face loop is one polygon-boundary edge
 * (both endpoints on the boundary, time≈0) plus interior bisector edges. We keep
 * only the latter.
 */
export function buildSkeletonGraph(skel) {
  const v = skel.vertices;
  const n = v.length / 3;
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) nodes[i] = { x: v[i * 3], y: v[i * 3 + 1], t: v[i * 3 + 2] };

  const seen = new Set();
  const edges = [];
  for (const face of skel.faces) {
    for (let k = 0; k < face.length; k++) {
      const a = face[k];
      const b = face[(k + 1) % face.length];
      // Polygon boundary edge: both endpoints sit on the boundary (time ≈ 0).
      if (nodes[a].t <= EPS_TIME && nodes[b].t <= EPS_TIME) continue;
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, len: dist2d(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y) });
    }
  }
  return { nodes, edges };
}

// --- polygon predicates (for robust endpoint attachment) ------------------

/** Even-odd point-in-polygon over all rings (outer + holes nested correctly). */
export function pointInPolygon(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const ccw = (ax, ay, bx, by, cx, cy) => (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);

/** Proper segment intersection (collinear/shared-endpoint touches don't count). */
function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  return (
    ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
  );
}

/** Is the straight segment p→q fully inside the polygon? */
function segmentInside(rings, p, q) {
  if (!pointInPolygon(rings, (p.x + q.x) / 2, (p.y + q.y) / 2)) return false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (segmentsCross(p.x, p.y, q.x, q.y, ring[j][0], ring[j][1], ring[i][0], ring[i][1])) return false;
    }
  }
  return true;
}

/**
 * If P is outside the polygon, snap it just inside (nearest point on the outer
 * ring, nudged toward the outer centroid). Returns P unchanged if already in.
 */
export function clampInside(rings, P) {
  if (pointInPolygon(rings, P.x, P.y)) return { x: P.x, y: P.y };
  const outer = rings[0];
  let best = null;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = { x: outer[j][0], y: outer[j][1] };
    const b = { x: outer[i][0], y: outer[i][1] };
    const pr = projectPointToSegment(P.x, P.y, a, b);
    if (!best || pr.dist < best.dist) best = pr;
  }
  let cx = 0, cy = 0;
  for (const [x, y] of outer) { cx += x; cy += y; }
  cx /= outer.length; cy /= outer.length;
  // Nudge a hair toward the centroid so the snapped point is strictly interior.
  return { x: best.x + (cx - best.x) * 1e-3, y: best.y + (cy - best.y) * 1e-3 };
}

function projectPointToSegment(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L2 = vx * vx + vy * vy || 1e-12;
  let t = ((px - a.x) * vx + (py - a.y) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * vx;
  const y = a.y + t * vy;
  return { x, y, t, dist: dist2d(px, py, x, y) };
}

function dijkstra(adj, start, goal) {
  const N = adj.length;
  const dist = new Array(N).fill(Infinity);
  const prev = new Array(N).fill(-1);
  const done = new Array(N).fill(false);
  dist[start] = 0;
  // Simple O(V^2) selection — skeletons here are well under a few thousand nodes.
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1 || u === goal) break;
    done[u] = true;
    for (const { to, w } of adj[u]) {
      if (dist[u] + w < dist[to]) { dist[to] = dist[u] + w; prev[to] = u; }
    }
  }
  if (dist[goal] === Infinity) return null;
  const path = [];
  for (let u = goal; u !== -1; u = prev[u]) path.push(u);
  return path.reverse();
}

/**
 * @param skel   str8 skeleton output for the polygon.
 * @param rings  the polygon (outer ring first, then holes) — used to keep the
 *               endpoint connectors inside the polygon.
 * @param A,B    {x,y} query points. Points outside the polygon are snapped in.
 * @param alpha  0 = shortest path on the spine; larger = prefer central
 *               (high-clearance) edges even if longer.
 * @param visibility  require endpoint connectors to stay inside the polygon
 *               (default true). Set false for the naive nearest-edge attach.
 * @returns      Array of {x,y,t} path points, or null if disconnected.
 */
export function findCentralPath(skel, rings, A, B, { alpha = 1, visibility = true, attachMode = 'edge', goalWeighted = true } = {}) {
  const { nodes, edges } = buildSkeletonGraph(skel);
  if (edges.length === 0) return null;
  const baseN = nodes.length; // skeleton-vertex count, before temp nodes

  // Which skeleton face contains point P? Each face is a vertex-index loop.
  const faceContaining = (P) => {
    for (const face of skel.faces) {
      const ring = face.map((i) => [nodes[i].x, nodes[i].y]);
      if (pointInPolygon([ring], P.x, P.y)) return face;
    }
    return null;
  };

  let maxT = 1e-9;
  for (const nd of nodes) if (nd.t > maxT) maxT = nd.t;

  // Edge cost: length scaled up where clearance is low.
  const edgeW = (len, clearance) => len * (1 + alpha * (1 - clearance / maxT));

  const adj = nodes.map(() => []);
  const link = (i, j, w) => { adj[i].push({ to: j, w }); adj[j].push({ to: i, w }); };

  for (const e of edges) link(e.a, e.b, edgeW(e.len, (nodes[e.a].t + nodes[e.b].t) / 2));

  // Attach a query point to the graph. Gather candidate attachment points
  // (projections onto each skeleton edge + interior skeleton nodes), then pick
  // the nearest one whose straight connector to P stays inside the polygon.
  function attach(P0, goal0) {
    const P = clampInside(rings, P0);
    const goal = goal0 ? clampInside(rings, goal0) : null;

    // Face-node mode: jump to the best visible skeleton node of the face that
    // actually contains P (its local spine), instead of the nearest edge point.
    // "Best" = the visible face node that best continues toward the goal:
    // minimize dist(P, node) + dist(node, goal), so the entry heads the right
    // way instead of backtracking. Falls back to nearest when no goal is given.
    if (attachMode === 'faceNode') {
      const face = faceContaining(P);
      if (face) {
        let best = null;
        for (const idx of face) {
          if (nodes[idx].t <= EPS_TIME) continue; // skip the face's boundary corners
          const d = dist2d(P.x, P.y, nodes[idx].x, nodes[idx].y);
          const score = goal && goalWeighted ? d + dist2d(nodes[idx].x, nodes[idx].y, goal.x, goal.y) : d;
          if (best && score >= best.score) continue;
          if (visibility && !segmentInside(rings, P, nodes[idx])) continue;
          best = { idx, d, score };
        }
        if (best) {
          const pid = nodes.length;
          nodes.push({ x: P.x, y: P.y, t: 0 });
          adj.push([]);
          link(pid, best.idx, best.d); // connector: pure length
          return pid;
        }
      }
      // no usable face node — fall through to edge attachment
    }

    const cands = [];
    for (const e of edges) {
      const pr = projectPointToSegment(P.x, P.y, nodes[e.a], nodes[e.b]);
      cands.push({ dist: pr.dist, kind: 'edge', e, x: pr.x, y: pr.y, t: lerp(nodes[e.a].t, nodes[e.b].t, pr.t) });
    }
    for (let i = 0; i < baseN; i++) {
      if (nodes[i].t <= EPS_TIME) continue; // skip boundary vertices as targets
      cands.push({ dist: dist2d(P.x, P.y, nodes[i].x, nodes[i].y), kind: 'node', idx: i, x: nodes[i].x, y: nodes[i].y, t: nodes[i].t });
    }
    cands.sort((a, b) => a.dist - b.dist);

    let chosen = null;
    if (visibility) chosen = cands.find((c) => segmentInside(rings, P, c));
    if (!chosen) chosen = cands[0]; // fall back to nearest if nothing visible

    const pid = nodes.length;
    nodes.push({ x: P.x, y: P.y, t: 0 });
    adj.push([]);

    if (chosen.kind === 'node') {
      link(pid, chosen.idx, dist2d(P.x, P.y, chosen.x, chosen.y)); // connector: pure length
    } else {
      const projId = nodes.length;
      nodes.push({ x: chosen.x, y: chosen.y, t: chosen.t });
      adj.push([]);
      link(pid, projId, dist2d(P.x, P.y, chosen.x, chosen.y)); // connector: pure length
      for (const end of [chosen.e.a, chosen.e.b]) {
        link(projId, end, edgeW(dist2d(chosen.x, chosen.y, nodes[end].x, nodes[end].y), (chosen.t + nodes[end].t) / 2));
      }
    }
    return pid;
  }

  const path = dijkstra(adj, attach(A, B), attach(B, A));
  return path ? path.map((i) => ({ x: nodes[i].x, y: nodes[i].y, t: nodes[i].t })) : null;
}

// --- refinement: string-pull + smoothing ----------------------------------

function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy || 1e-12;
  let t = ((px - ax) * vx + (py - ay) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Clearance at an arbitrary point: distance to the nearest polygon edge. */
export function clearanceAt(rings, x, y) {
  let m = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = pointSegDist(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < m) m = d;
    }
  }
  return m;
}

// Can we replace a run of the path with the straight segment p→q? It must stay
// inside the polygon and keep clearance ≥ minClearance the whole way.
function shortcutOK(rings, p, q, minClearance) {
  if (!segmentInside(rings, p, q)) return false;
  if (minClearance <= 0) return true;
  const len = dist2d(p.x, p.y, q.x, q.y);
  const steps = Math.max(8, Math.ceil(len / (minClearance * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    if (clearanceAt(rings, p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u) < minClearance) return false;
  }
  return true;
}

/**
 * Clearance-bounded string-pulling: greedily replace sub-runs of the path with
 * straight shortcuts, as long as they stay inside and keep clearance ≥
 * minClearance. `minClearance = 0` pulls the path taut (toward the direct,
 * wall-hugging route); larger values keep it fat and central. Also removes the
 * skeleton's jaggedness.
 */
export function stringPull(path, rings, { minClearance = 0 } = {}) {
  if (!path || path.length <= 2) return path;
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    for (; j > i + 1; j--) if (shortcutOK(rings, path[i], path[j], minClearance)) break;
    // j === i+1 is always taken as a fallback (it's a sub-segment of the input).
    out.push(path[j]);
    i = j;
  }
  return out.map((p) => ({ x: p.x, y: p.y, t: clearanceAt(rings, p.x, p.y) }));
}

/**
 * Corner-rounding smoothing that respects walls: a corner is only rounded if
 * the rounded points (and the chord between them) keep clearance ≥
 * minClearance. Corners pressed against a wall (e.g. a taut path hugging a
 * reflex vertex) are left sharp, so the curve never bulges outside. Endpoints
 * are preserved.
 *
 * `minClearance` defaults to a small fraction of the path's own clearance so it
 * scales with the polygon; pass an explicit value to override.
 */
export function smoothPath(path, rings, { iterations = 2, minClearance } = {}) {
  if (!path || path.length < 3) return path;
  if (minClearance == null) {
    const maxT = Math.max(1e-9, ...path.map((p) => p.t || 0));
    minClearance = 0.05 * maxT;
  }
  const ok = (p) => clearanceAt(rings, p.x, p.y) >= minClearance;

  let pts = path.map((p) => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], v = pts[i], b = pts[i + 1];
      // Round the corner at v toward its neighbours (keeps the curve near v).
      const q = { x: v.x * 0.75 + a.x * 0.25, y: v.y * 0.75 + a.y * 0.25 };
      const r = { x: v.x * 0.75 + b.x * 0.25, y: v.y * 0.75 + b.y * 0.25 };
      const mid = { x: (q.x + r.x) / 2, y: (q.y + r.y) / 2 };
      const last = out[out.length - 1];
      // Round only if the rounded points clear the walls AND the new segments
      // stay inside; otherwise keep the corner sharp (it's hugging a wall).
      if (ok(q) && ok(r) && ok(mid) && segmentInside(rings, last, q) && segmentInside(rings, q, r)) {
        out.push(q, r);
      } else {
        out.push(v);
      }
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts.map((p) => ({ x: p.x, y: p.y, t: clearanceAt(rings, p.x, p.y) }));
}

// --- region-to-region paths -----------------------------------------------

/**
 * SKETCH: central path between two sub-polygons inside a container, boundary to
 * boundary. The path runs from the best point on regionA's boundary, through
 * the container's straight skeleton, to the best point on regionB's boundary.
 *
 * Mechanism: sample each region's boundary, attach every sample to the
 * container skeleton (face-node, goal-weighted toward the other region), then a
 * virtual super-source over A's samples and super-sink over B's. One Dijkstra
 * selects the optimal boundary exit/entry pair.
 *
 * @param skel   straight skeleton of the CONTAINER polygon.
 * @param rings  the container polygon (outer ring first, then holes).
 * @param regionA,regionB  sub-polygons (each `[ring, ...]`) inside the container.
 */
export function findRegionPath(skel, rings, regionA, regionB, { alpha = 1, visibility = true } = {}) {
  const { nodes, edges } = buildSkeletonGraph(skel);
  if (edges.length === 0) return null;

  let maxT = 1e-9;
  for (const nd of nodes) if (nd.t > maxT) maxT = nd.t;
  const edgeW = (len, c) => len * (1 + alpha * (1 - c / maxT));

  const adj = nodes.map(() => []);
  const link = (i, j, w) => { adj[i].push({ to: j, w }); adj[j].push({ to: i, w }); };
  for (const e of edges) link(e.a, e.b, edgeW(e.len, (nodes[e.a].t + nodes[e.b].t) / 2));

  const faceContaining = (P) => {
    for (const face of skel.faces) {
      const ring = face.map((i) => [nodes[i].x, nodes[i].y]);
      if (pointInPolygon([ring], P.x, P.y)) return face;
    }
    return null;
  };

  // Attach a boundary point P to the skeleton (face-node, goal-weighted toward
  // `goal`; nearest-edge fallback) and return its node id.
  function attach(P, goal) {
    const face = faceContaining(P);
    if (face) {
      let best = null;
      for (const idx of face) {
        if (nodes[idx].t <= EPS_TIME) continue;
        const d = dist2d(P.x, P.y, nodes[idx].x, nodes[idx].y);
        const score = goal ? d + dist2d(nodes[idx].x, nodes[idx].y, goal.x, goal.y) : d;
        if (best && score >= best.score) continue;
        if (visibility && !segmentInside(rings, P, nodes[idx])) continue;
        best = { idx, d, score };
      }
      if (best) {
        const pid = nodes.length;
        nodes.push({ x: P.x, y: P.y, t: 0 });
        adj.push([]);
        link(pid, best.idx, best.d);
        return pid;
      }
    }
    let be = null;
    for (const e of edges) {
      const pr = projectPointToSegment(P.x, P.y, nodes[e.a], nodes[e.b]);
      if (!be || pr.dist < be.pr.dist) be = { pr, e };
    }
    if (!be) return null;
    const projId = nodes.length;
    nodes.push({ x: be.pr.x, y: be.pr.y, t: lerp(nodes[be.e.a].t, nodes[be.e.b].t, be.pr.t) });
    adj.push([]);
    const pid = nodes.length;
    nodes.push({ x: P.x, y: P.y, t: 0 });
    adj.push([]);
    link(pid, projId, dist2d(P.x, P.y, be.pr.x, be.pr.y));
    for (const end of [be.e.a, be.e.b]) {
      link(projId, end, edgeW(dist2d(be.pr.x, be.pr.y, nodes[end].x, nodes[end].y), (nodes[projId].t + nodes[end].t) / 2));
    }
    return pid;
  }

  // Container size, for boundary sampling density.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const step = (Math.max(maxX - minX, maxY - minY) || 1) / 60;

  const samples = (region) => {
    const ring = region[0];
    const pts = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(segLen / step));
      for (let k = 0; k < n; k++) {
        const u = k / n;
        pts.push({ x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u });
      }
    }
    return pts;
  };
  const centroid = (region) => {
    const r = region[0]; let x = 0, y = 0;
    for (const [a, b] of r) { x += a; y += b; }
    return { x: x / r.length, y: y / r.length };
  };

  const cA = centroid(regionA), cB = centroid(regionB);

  // Super-source over A's boundary, super-sink over B's. The 0-cost links make
  // the path's true endpoints the chosen boundary points.
  const S = nodes.length; nodes.push({ x: cA.x, y: cA.y, t: 0 }); adj.push([]);
  for (const p of samples(regionA)) { const pid = attach(p, cB); if (pid != null) link(S, pid, 0); }
  const T = nodes.length; nodes.push({ x: cB.x, y: cB.y, t: 0 }); adj.push([]);
  for (const p of samples(regionB)) { const pid = attach(p, cA); if (pid != null) link(pid, T, 0); }

  const idxPath = dijkstra(adj, S, T);
  if (!idxPath) return null;
  // Strip the virtual source/sink → boundary-to-boundary path.
  return idxPath.slice(1, -1).map((i) => ({ x: nodes[i].x, y: nodes[i].y, t: nodes[i].t }));
}

/** Quick metrics for judging a path: total length and clearance stats. */
export function pathStats(path) {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += dist2d(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y);
  // Clearance over the interior of the path (exclude the two endpoints, which are t≈0).
  const mid = path.slice(1, -1);
  const clr = mid.map((p) => p.t);
  return {
    length,
    points: path.length,
    minClearance: clr.length ? Math.min(...clr) : 0,
    meanClearance: clr.length ? clr.reduce((a, b) => a + b, 0) / clr.length : 0,
  };
}
