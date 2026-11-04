#!/usr/bin/env bash
# Build the contract to res/ron_poker_table.wasm.
# NEAR runs WebAssembly MVP, so std is rebuilt with target-cpu=mvp (needs the rust-src component).
set -euo pipefail
cd "$(dirname "$0")"
RUSTC_BOOTSTRAP=1 RUSTFLAGS="-C target-cpu=mvp" \
  cargo build --release --target wasm32-unknown-unknown -Z build-std=std,panic_abort
mkdir -p res
if command -v wasm-opt >/dev/null; then
  wasm-opt target/wasm32-unknown-unknown/release/ron_poker_table.wasm --mvp-features -Oz --strip-debug -o res/ron_poker_table.wasm
else
  cp target/wasm32-unknown-unknown/release/ron_poker_table.wasm res/
fi
ls -la res/ron_poker_table.wasm
