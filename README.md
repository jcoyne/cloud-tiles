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

## Compared with an IIIF image server

| | cloud-tiles (byte ranges) | IIIF Image API server |
|---|---|---|
| **Infrastructure** | ✅ Static file hosting: S3, a CDN, or any server that honours `Range` with CORS | ❌ An image server (Cantaloupe, IIPImage, …) with CPU and a tile cache to run and scale |
| **Server cost per view** | ✅ Bandwidth only; decoding happens in the browser | ❌ The server decodes and re-encodes every tile that isn't cached |
| **Image fidelity** | ✅ The original codestream is decoded, within ±1 of Kakadu | ❌ Tiles are re-encoded, usually as JPEG, a second lossy generation |
| **Bytes per view** | ⚠️ The file's own packets; in our tests the first view fetches 15–30% of the file. More for lossless masters, and files without PLT or TLM have to be downloaded in full | ⚠️ Re-encoded tiles at the quality the server picks; usually small |
| **Client requirements** | ❌ A modern browser with WebAssembly and Web Workers; decoding uses the client's CPU (about 65–85 ms per tile) | ✅ Anything that can display a JPEG |
| **Viewer support** | ❌ Only this viewer reads `RangeJP2`; Mirador, UV and others fall back to the Image API (see [docs/iiif.md](docs/iiif.md)) | ✅ Every IIIF viewer, plus a large ecosystem of tools |
| **File requirements** | ❌ The file must carry TLM (tiled) or PLT (untiled); see [Encoding](#encoding) | ✅ Any image the server can read |
| **Sharing a specific region** | ❌ No region URL. A link opens the whole image (`?src=`, `?manifest=`, `&canvas=`), and there's no image to embed elsewhere | ✅ `/{region}/{size}/{rotation}/{quality}.{format}` is a shareable, embeddable image |
| **Derivatives** (thumbnails, crops, rotation, greyscale, format conversion) | ❌ None; they have to be pre-generated | ✅ Any combination, on demand by URL |
| **Restricting dimensions** | ❌ Anyone who can view can read the full-resolution file. A size cap means publishing a separate, reduced file | ✅ `maxWidth`, `maxHeight` and `maxArea` in `info.json` cap what the server returns |
| **Access control** | ⚠️ All-or-nothing on the file, through IIIF Auth 2.0 and credentialed CORS | ✅ Per request: by size, region or user, with watermarking if needed |
| **Downloading the master** | ⚠️ Anyone who can view can also download the original | ✅ The original file stays on the server unless you publish it |
| **Availability** | ✅ Fails only when the file host does; a CDN absorbs traffic spikes | ⚠️ Uncached tiles depend on the image server keeping up |
| **Opening an image** | ⚠️ A few header requests before the first tile (3–5 requests, 90–275 KB in our samples) | ✅ One `info.json`, then tiles |

The two approaches can be combined: the same JP2 can be served by range to this
viewer and by an image server for derivatives, region links, size limits and
other viewers. A manifest can advertise both (see [docs/iiif.md](docs/iiif.md)).

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

## Encoding

Untiled JP2s need PLT (`ORGgen_plt=yes`), or the viewer has to download the
whole file. See [docs/encoding-recommendations.md](docs/encoding-recommendations.md)
for measured `kdu_compress` layouts and suggested changes to SDR's encoder.
