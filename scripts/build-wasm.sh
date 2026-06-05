#!/usr/bin/env bash
# Build the CGAL straight-skeleton core to a single-file ES module.
# Requires the Emscripten SDK to be active (`source .../emsdk_env.sh`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build/wasm"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "error: emcmake not found. Activate emsdk first, e.g.:" >&2
  echo "  source \"\$HOME/Documents/emsdk/emsdk_env.sh\"" >&2
  exit 1
fi

# Allow overriding the header location (Intel macOS / Linux).
DEPS_INCLUDE_DIR="${DEPS_INCLUDE_DIR:-/opt/homebrew/include}"

emcmake cmake -S "$ROOT/src/core" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DDEPS_INCLUDE_DIR="$DEPS_INCLUDE_DIR"

cmake --build "$BUILD_DIR" -j

echo "built: $ROOT/src/core/skeleton.js ($(du -h "$ROOT/src/core/skeleton.js" | cut -f1))"
