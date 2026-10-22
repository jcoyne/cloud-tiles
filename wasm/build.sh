#!/usr/bin/env bash
# Build the j2k WASM decoder and emit wasm-bindgen glue into web/src/wasm-pkg.
# Usage: wasm/build.sh [--no-simd]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../web/src/wasm-pkg"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

# simd128 is supported by every current browser and is ~5-12% faster.
if [[ "${1:-}" != "--no-simd" ]]; then
  export RUSTFLAGS="-C target-feature=+simd128"
fi

cd "$here"

# Vendored j2k at a pinned commit.
J2K_REV=d849d62a67d26b8fd85289f8b2bdb7f171ab8592
vendor="$here/vendor/j2k"
if [[ ! -d "$vendor/.git" ]]; then
  git clone --quiet https://github.com/frames-sg/j2k.git "$vendor"
fi
if [[ "$(git -C "$vendor" rev-parse HEAD)" != "$J2K_REV" || -n "$(git -C "$vendor" status --porcelain)" ]]; then
  git -C "$vendor" cat-file -e "$J2K_REV^{commit}" 2>/dev/null || git -C "$vendor" fetch --quiet origin
  git -C "$vendor" checkout --quiet --force "$J2K_REV"
fi

cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir "$out" --out-name j2k \
  "$here/target/wasm32-unknown-unknown/release/cloud_tiles_wasm.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-simd \
    "$out/j2k_bg.wasm" -o "$out/j2k_bg.wasm"
fi
ls -l "$out/j2k_bg.wasm"
