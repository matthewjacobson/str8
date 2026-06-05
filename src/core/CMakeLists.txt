cmake_minimum_required(VERSION 3.20)
project(str8_core CXX)

# Configure with emcmake so the Emscripten toolchain is active:
#   emcmake cmake -S src/core -B build/wasm -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/wasm
#
# CGAL's Straight_skeleton_2 is header-only with the EPICK kernel, so we do NOT
# use find_package(CGAL); we just put CGAL + Boost headers on the include path.
# That avoids dragging in GMP/MPFR (native libs we don't want to cross-compile)
# and keeps the WASM build self-contained.

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Header-only dependencies. Override with -DDEPS_INCLUDE_DIR=... if your CGAL /
# Boost headers live elsewhere (e.g. /usr/local/include on Intel macOS).
set(DEPS_INCLUDE_DIR "/opt/homebrew/include" CACHE PATH "CGAL + Boost header root")

add_executable(skeleton skeleton.cpp)
target_include_directories(skeleton PRIVATE ${DEPS_INCLUDE_DIR})

# Strip CGAL's runtime checks: smaller code, and a failed precondition aborts
# the whole WASM module instead of letting us return null gracefully.
target_compile_definitions(skeleton PRIVATE
  # No GMP/MPFR: those are native libs we can't link into WASM. With them
  # disabled, EPICK's exact-predicate fallback uses CGAL's header-only number
  # types (Quotient<MP_Float>) instead of Gmpq.
  CGAL_DISABLE_GMP=1
  CGAL_NO_ASSERTIONS
  CGAL_NO_PRECONDITIONS
  CGAL_NO_POSTCONDITIONS
  CGAL_NO_WARNINGS
)

target_compile_options(skeleton PRIVATE -O3 -fexceptions)

target_link_options(skeleton PRIVATE
  --bind                              # embind
  -fexceptions                        # CGAL throws on degenerate input
  -O3
  -sMODULARIZE=1
  -sEXPORT_ES6=1                      # emit an ES module (default export = factory)
  -sEXPORT_NAME=createSkeletonModule
  -sSINGLE_FILE=1                     # base64-embed the wasm in the .js
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU32']
  --no-entry
)

# Emit skeleton.js (with embedded wasm) straight into src/core so the TS wrapper
# can import it relatively.
set_target_properties(skeleton PROPERTIES
  SUFFIX ".js"
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)
