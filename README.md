# cloud-tiles

A static deep-zoom viewer for JPEG 2000 that makes HTTP range requests
against a single JP2/JPH file, with no image server. Decoding uses
[frames-sg/j2k](https://github.com/frames-sg/j2k) compiled to WebAssembly and
runs in Web Workers. Display uses OpenSeadragon. See [PLAN.md](PLAN.md).

## How it works

- **Tiled files** (e.g. Kakadu `Stiles={1024,1024} ORGtparts=R ORGgen_tlm=7`):
  TLM in the main header locates every tile-part. For each view tile, the
  client fetches the tile-parts up to the needed resolution and rewrites SIZ
  into a small codestream containing only those tiles.
- **Untiled archive files** with PLT (e.g. Stanford's Kakadu 7.1 JP2s): PLT
  gives every packet's length. The client fetches only the precincts that
  overlap the view and swaps every other packet for a one-byte empty packet.

Both paths are tested to be bit-exact against decoding the whole file.

## Requirements

- Rust via rustup (`brew install rustup`); `wasm/rust-toolchain.toml` pins 1.99.0 + `wasm32-unknown-unknown`
- `cargo install wasm-bindgen-cli --version 0.2.129`
- `wasm-opt` (`brew install binaryen`), optional
- Node 22+
- Kakadu (`kdu_compress`, `kdu_expand`) to make fixtures and run the comparison scripts

## Run

```bash
wasm/build.sh                 # builds web/src/wasm-pkg (simd128; --no-simd to disable)
cd web && npm install
npm run dev                   # http://localhost:5173/?src=<url of a CORS-enabled JP2>
```

`?manifest=<url of a IIIF Presentation 3 manifest>` opens a manifest instead,
reading each canvas by byte range when its image is a JP2 and falling back to
the IIIF Image API otherwise. The **IIIF manifest** button shows the manifest
in use, or one generated for the open file. See [docs/iiif.md](docs/iiif.md).

Test fixtures go in `testdata/`; see [testdata/README.md](testdata/README.md).

```bash
cd web && npm test            # parser + synthesis tests (needs fixtures and the wasm build)
node scripts/screenshot.mjs <src> out.png [zoom-steps]   # headless check with the dev server running
node ../wasm/test/compare-kakadu.mjs ../testdata/stanford-army.jp2 3
```

## Server requirements

Any server that honours `Range` and sends `Access-Control-Allow-Origin` plus
`Access-Control-Expose-Headers: Content-Range`. See
[docs/stacks-recommendations.md](docs/stacks-recommendations.md) for suggested
improvements to stacks.stanford.edu.
