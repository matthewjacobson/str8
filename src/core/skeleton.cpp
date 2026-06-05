// str8 — modern straight-skeleton WASM core
//
// Wraps CGAL's Straight_skeleton_2 package and exposes a single embind entry
// point that returns clean JS objects. Input is a flattened coordinate buffer
// plus per-ring vertex counts; output is a typed-array of (x, y, time) vertices
// and a list of skeleton faces (each a list of vertex indices into that array).
//
// Robustness: we build the polygon with the inexact-constructions kernel
// (EPICK) and first try to construct the skeleton with it — fast, and fine for
// most inputs. Highly symmetric inputs (e.g. evenly spaced identical holes)
// produce many simultaneous wavefront events that EPICK's rounded constructions
// can't resolve consistently, so on failure we retry with the exact-
// constructions kernel (EPECK). EPECK is slower but robust.

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

using namespace emscripten;

typedef CGAL::Exact_predicates_inexact_constructions_kernel InexactK;
typedef CGAL::Exact_predicates_exact_constructions_kernel   ExactK;

// The polygon is always stored with the inexact kernel — cheap double coords.
typedef CGAL::Polygon_2<InexactK>            Polygon_2;
typedef CGAL::Polygon_with_holes_2<InexactK> Polygon_with_holes;

// Build a JS Float32Array that owns a copy of `v`. The typed_memory_view is a
// transient view over the WASM heap; the Float32Array constructor copies out of
// it, so the result stays valid after `v` is destroyed.
static val to_float32_array(const std::vector<float>& v) {
  return val::global("Float32Array").new_(typed_memory_view(v.size(), v.data()));
}

// Walk every face of a skeleton (templated on its kernel) into the JS result.
template <class Ss>
static val serialize(const std::shared_ptr<Ss>& ss) {
  typedef typename Ss::Vertex_const_handle   Vertex_const_handle;
  typedef typename Ss::Halfedge_const_handle Halfedge_const_handle;

  std::vector<float> vertices;                               // [x, y, time, ...]
  std::unordered_map<Vertex_const_handle, int> vertexIndex;  // dedup across faces
  val faces = val::array();
  int faceCount = 0;

  for (auto f = ss->faces_begin(); f != ss->faces_end(); ++f) {
    Halfedge_const_handle begin = f->halfedge();
    if (begin == Halfedge_const_handle()) {
      continue;
    }

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

// Construct the interior skeleton of `poly` with construction kernel K and
// serialize it, or return null on failure (CGAL returns null or throws).
template <class K>
static val build_with_kernel(const Polygon_with_holes& poly) {
  try {
    auto ss = CGAL::create_interior_straight_skeleton_2(poly, K());
    if (ss) {
      return serialize(ss);
    }
  } catch (...) {
    // fall through to null
  }
  return val::null();
}

// rings: flat [x0,y0, x1,y1, ...] across every ring, concatenated in order.
// ringSizes: vertex count of each ring. ringSizes[0] is the outer boundary
//   (expected CCW); the rest are holes (expected CW). Orientation and the
//   open/closed convention are normalized on the JS side before we get here.
// forceExact: skip the fast inexact attempt and go straight to EPECK.
//
// Returns { vertices: Float32Array, faces: number[][] } or null on failure.
val build_interior_skeleton(val ringsVal, val ringSizesVal, bool forceExact) {
  const std::vector<double> coords    = convertJSArrayToNumberVector<double>(ringsVal);
  const std::vector<int>    ringSizes = convertJSArrayToNumberVector<int>(ringSizesVal);

  if (ringSizes.empty() || ringSizes[0] < 3) {
    return val::null();
  }

  auto read_ring = [&](size_t offset, int count, Polygon_2& out) {
    for (int i = 0; i < count; ++i) {
      out.push_back(InexactK::Point_2(coords[offset + 2 * i], coords[offset + 2 * i + 1]));
    }
  };

  size_t offset = 0;

  Polygon_2 outer;
  read_ring(offset, ringSizes[0], outer);
  offset += 2 * static_cast<size_t>(ringSizes[0]);

  Polygon_with_holes poly(outer);
  for (size_t r = 1; r < ringSizes.size(); ++r) {
    Polygon_2 hole;
    read_ring(offset, ringSizes[r], hole);
    offset += 2 * static_cast<size_t>(ringSizes[r]);
    poly.add_hole(hole);
  }

  if (!forceExact) {
    val fast = build_with_kernel<InexactK>(poly);
    if (!fast.isNull()) {
      return fast;
    }
  }
  // Robust fallback (or forced): exact constructions.
  return build_with_kernel<ExactK>(poly);
}

EMSCRIPTEN_BINDINGS(str8) {
  function("buildInteriorSkeleton", &build_interior_skeleton);
}
