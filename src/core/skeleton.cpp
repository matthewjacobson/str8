// str8 — modern straight-skeleton WASM core
//
// Wraps CGAL's Straight_skeleton_2 package and exposes embind entry points that
// return clean JS objects:
//   - buildInteriorSkeleton / buildExteriorSkeleton -> {vertices, faces}
//   - offsetPolygons (interior/exterior inset/outset) -> [{outer, holes}]
//
// Robustness: each entry point builds with the inexact-constructions kernel
// (EPICK) first — fast, fine for most inputs — and on failure retries with the
// exact-constructions kernel (EPECK). Symmetric inputs with many simultaneous
// wavefront events can't be resolved consistently under EPICK; EPECK is slower
// but robust.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <memory>
#include <vector>
#include <unordered_map>

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Exact_predicates_exact_constructions_kernel.h>
#include <CGAL/Polygon_2.h>
#include <CGAL/Polygon_with_holes_2.h>
#include <CGAL/Straight_skeleton_2.h>
#include <CGAL/create_straight_skeleton_2.h>
#include <CGAL/create_straight_skeleton_from_polygon_with_holes_2.h>
#include <CGAL/create_offset_polygons_2.h>
#include <CGAL/create_offset_polygons_from_polygon_with_holes_2.h>
#include <CGAL/arrange_offset_polygons_2.h>

#include <algorithm>
#include <cmath>

using namespace emscripten;

typedef CGAL::Exact_predicates_inexact_constructions_kernel InexactK;
typedef CGAL::Exact_predicates_exact_constructions_kernel   ExactK;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Build a JS Float32Array that owns a copy of `v`. The typed_memory_view is a
// transient view over the WASM heap; the Float32Array constructor copies out of
// it, so the result stays valid after `v` is destroyed.
static val to_float32_array(const std::vector<float>& v) {
  return val::global("Float32Array").new_(typed_memory_view(v.size(), v.data()));
}

// Build a Polygon_2<K> from `count` (x, y) pairs starting at coords[offset].
template <class K>
static CGAL::Polygon_2<K> read_ring(const std::vector<double>& coords, size_t offset, int count) {
  CGAL::Polygon_2<K> ring;
  for (int i = 0; i < count; ++i) {
    ring.push_back(typename K::Point_2(coords[offset + 2 * i], coords[offset + 2 * i + 1]));
  }
  return ring;
}

// Build a Polygon_with_holes_2<K> from the flat coords + per-ring sizes.
// When includeHoles is false, only the outer boundary is used.
template <class K>
static CGAL::Polygon_with_holes_2<K> make_pwh(
    const std::vector<double>& coords, const std::vector<int>& sizes, bool includeHoles) {
  size_t offset = 0;
  CGAL::Polygon_with_holes_2<K> pwh(read_ring<K>(coords, offset, sizes[0]));
  offset += 2 * static_cast<size_t>(sizes[0]);
  for (size_t r = 1; r < sizes.size(); ++r) {
    if (includeHoles) pwh.add_hole(read_ring<K>(coords, offset, sizes[r]));
    offset += 2 * static_cast<size_t>(sizes[r]);
  }
  return pwh;
}

// ---------------------------------------------------------------------------
// Skeleton serialization (vertices + faces)
// ---------------------------------------------------------------------------

template <class Ss>
static val serialize_skeleton(const std::shared_ptr<Ss>& ss) {
  typedef typename Ss::Vertex_const_handle   Vertex_const_handle;
  typedef typename Ss::Halfedge_const_handle Halfedge_const_handle;

  std::vector<float> vertices;                               // [x, y, time, ...]
  std::unordered_map<Vertex_const_handle, int> vertexIndex;  // dedup across faces
  val faces = val::array();
  int faceCount = 0;

  for (auto f = ss->faces_begin(); f != ss->faces_end(); ++f) {
    Halfedge_const_handle begin = f->halfedge();
    if (begin == Halfedge_const_handle()) continue;

    val face = val::array();
    int n = 0;
    Halfedge_const_handle h = begin;
    do {
      Vertex_const_handle vh = h->vertex();
      auto it = vertexIndex.find(vh);
      int idx;
      if (it == vertexIndex.end()) {
        idx = static_cast<int>(vertices.size() / 3);
        vertexIndex.emplace(vh, idx);
        vertices.push_back(static_cast<float>(CGAL::to_double(vh->point().x())));
        vertices.push_back(static_cast<float>(CGAL::to_double(vh->point().y())));
        vertices.push_back(static_cast<float>(CGAL::to_double(vh->time())));
      } else {
        idx = it->second;
      }
      face.set(n++, idx);
      h = h->next();
    } while (h != begin);

    faces.set(faceCount++, face);
  }

  val result = val::object();
  result.set("vertices", to_float32_array(vertices));
  result.set("faces", faces);
  return result;
}

// ---------------------------------------------------------------------------
// Offset-polygon serialization ([{outer: Float32Array, holes: Float32Array[]}])
// ---------------------------------------------------------------------------

template <class K>
static val ring_to_f32(const CGAL::Polygon_2<K>& ring) {
  std::vector<float> v;
  for (auto it = ring.vertices_begin(); it != ring.vertices_end(); ++it) {
    v.push_back(static_cast<float>(CGAL::to_double(it->x())));
    v.push_back(static_cast<float>(CGAL::to_double(it->y())));
  }
  return to_float32_array(v);
}

template <class K>
static val serialize_offsets(
    const std::vector<std::shared_ptr<CGAL::Polygon_with_holes_2<K>>>& polys) {
  val out = val::array();
  int n = 0;
  for (const auto& p : polys) {
    if (!p) continue;
    val obj = val::object();
    obj.set("outer", ring_to_f32<K>(p->outer_boundary()));
    val holes = val::array();
    int hi = 0;
    for (auto h = p->holes_begin(); h != p->holes_end(); ++h) {
      holes.set(hi++, ring_to_f32<K>(*h));
    }
    obj.set("holes", holes);
    out.set(n++, obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-kernel builders
// ---------------------------------------------------------------------------

template <class K>
static val interior_skeleton(const std::vector<double>& coords, const std::vector<int>& sizes) {
  try {
    auto ss = CGAL::create_interior_straight_skeleton_2(make_pwh<K>(coords, sizes, true), K());
    if (ss) return serialize_skeleton(ss);
  } catch (...) {}
  return val::null();
}

template <class K>
static val exterior_skeleton(const std::vector<double>& coords, int outerCount, double maxOffset) {
  try {
    // Exterior skeleton depends only on the outer boundary.
    auto ss = CGAL::create_exterior_straight_skeleton_2(maxOffset, read_ring<K>(coords, 0, outerCount), K());
    if (ss) return serialize_skeleton(ss);
  } catch (...) {}
  return val::null();
}

// Arrange a set of raw offset contours into {outer, holes} polygons-with-holes
// and serialize them. For the exterior case, CGAL drops the bounding-frame
// contour and flips the orientation of the rest before arranging; we replicate
// that here so a reused exterior skeleton produces the same nesting as the
// one-shot create_exterior_skeleton_and_offset_polygons_with_holes_2 would.
template <class K>
static val arrange_and_serialize(
    std::vector<std::shared_ptr<CGAL::Polygon_2<K>>> raw, bool exterior) {
  if (exterior && !raw.empty()) {
    // The bounding frame's offset encloses everything, so it has the largest
    // area; remove that single contour. (Positional ordering isn't reliable
    // once the skeleton is built independently of the offset call.)
    size_t frame = 0;
    double maxArea = -1.0;
    for (size_t i = 0; i < raw.size(); ++i) {
      if (!raw[i]) continue;
      double a = std::abs(CGAL::to_double(raw[i]->area()));
      if (a > maxArea) { maxArea = a; frame = i; }
    }
    raw.erase(raw.begin() + frame);
    // Match CGAL: reverse all-but-first vertex of each remaining contour so the
    // orientation is what arrange_offset_polygons_2 expects for exterior offsets.
    for (auto& ptr : raw) {
      if (ptr && ptr->size() > 1) std::reverse(std::next(ptr->begin()), ptr->end());
    }
  }
  auto with_holes = CGAL::arrange_offset_polygons_2<CGAL::Polygon_with_holes_2<K>>(raw);
  return serialize_offsets<K>(with_holes);
}

// Build the straight skeleton ONCE, then derive every requested offset from it.
// Recomputing the skeleton per distance (the old one-shot path) is the dominant
// cost when stepping concentric contours, so reuse is a large win there.
// Returns { skeleton: {vertices, faces}, contours: [ [ {outer, holes}, ... ] ] }
// where contours[i] holds the offset polygons at distances[i].
template <class K>
static val offsets_batch(const std::vector<double>& coords, const std::vector<int>& sizes,
                         const std::vector<double>& distances, bool exterior) {
  try {
    val contours = val::array();
    val skel;

    if (exterior) {
      // Exterior offsetting concerns only the outer boundary. The exterior
      // skeleton is framed at a fixed distance, so frame it beyond the largest
      // requested offset and reuse it for them all.
      double maxd = 0.0;
      for (double d : distances) maxd = std::max(maxd, d);
      auto outer = read_ring<K>(coords, 0, sizes[0]);
      auto ss = CGAL::create_exterior_straight_skeleton_2(maxd, outer, K());
      if (!ss) return val::null();
      skel = serialize_skeleton(ss);
      for (size_t i = 0; i < distances.size(); ++i) {
        contours.set(static_cast<int>(i),
                     arrange_and_serialize<K>(
                         CGAL::create_offset_polygons_2<CGAL::Polygon_2<K>>(distances[i], *ss, K()),
                         true));
      }
    } else {
      auto ss = CGAL::create_interior_straight_skeleton_2(make_pwh<K>(coords, sizes, true), K());
      if (!ss) return val::null();
      skel = serialize_skeleton(ss);
      for (size_t i = 0; i < distances.size(); ++i) {
        contours.set(static_cast<int>(i),
                     arrange_and_serialize<K>(
                         CGAL::create_offset_polygons_2<CGAL::Polygon_2<K>>(distances[i], *ss, K()),
                         false));
      }
    }

    val result = val::object();
    result.set("skeleton", skel);
    result.set("contours", contours);
    return result;
  } catch (...) {}
  return val::null();
}

// ---------------------------------------------------------------------------
// embind entry points (try inexact, fall back to exact)
// ---------------------------------------------------------------------------

val build_interior_skeleton(val ringsVal, val ringSizesVal, bool forceExact) {
  const std::vector<double> coords = convertJSArrayToNumberVector<double>(ringsVal);
  const std::vector<int>    sizes  = convertJSArrayToNumberVector<int>(ringSizesVal);
  if (sizes.empty() || sizes[0] < 3) return val::null();

  if (!forceExact) {
    val fast = interior_skeleton<InexactK>(coords, sizes);
    if (!fast.isNull()) return fast;
  }
  return interior_skeleton<ExactK>(coords, sizes);
}

val build_exterior_skeleton(val ringsVal, val ringSizesVal, double maxOffset, bool forceExact) {
  const std::vector<double> coords = convertJSArrayToNumberVector<double>(ringsVal);
  const std::vector<int>    sizes  = convertJSArrayToNumberVector<int>(ringSizesVal);
  if (sizes.empty() || sizes[0] < 3 || maxOffset <= 0) return val::null();

  if (!forceExact) {
    val fast = exterior_skeleton<InexactK>(coords, sizes[0], maxOffset);
    if (!fast.isNull()) return fast;
  }
  return exterior_skeleton<ExactK>(coords, sizes[0], maxOffset);
}

val offset_polygons(val ringsVal, val ringSizesVal, val distancesVal, bool exterior, bool forceExact) {
  const std::vector<double> coords    = convertJSArrayToNumberVector<double>(ringsVal);
  const std::vector<int>    sizes     = convertJSArrayToNumberVector<int>(ringSizesVal);
  const std::vector<double> distances = convertJSArrayToNumberVector<double>(distancesVal);
  if (sizes.empty() || sizes[0] < 3 || distances.empty()) return val::null();

  if (!forceExact) {
    val fast = offsets_batch<InexactK>(coords, sizes, distances, exterior);
    if (!fast.isNull()) return fast;
  }
  return offsets_batch<ExactK>(coords, sizes, distances, exterior);
}

EMSCRIPTEN_BINDINGS(str8) {
  function("buildInteriorSkeleton", &build_interior_skeleton);
  function("buildExteriorSkeleton", &build_exterior_skeleton);
  function("offsetPolygons", &offset_polygons);
}
