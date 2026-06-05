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
export function findCentralPath(skel, rings, A, B, { alpha = 1, visibility = true } = {}) {
  const { nodes, edges } = buildSkeletonGraph(skel);
  if (edges.length === 0) return null;
  const baseN = nodes.length; // skeleton-vertex count, before temp nodes

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
  function attach(P0) {
    const P = clampInside(rings, P0);

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

  const path = dijkstra(adj, attach(A), attach(B));
  return path ? path.map((i) => ({ x: nodes[i].x, y: nodes[i].y, t: nodes[i].t })) : null;
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
