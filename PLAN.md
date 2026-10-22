# cloud-tiles: Range-request JPEG 2000 viewer

A static, server-free deep-zoom viewer. The browser makes HTTP range requests
against a large JP2/JPH file, fetches only the packets the current viewport needs,
decodes them in a Web Worker with [frames-sg/j2k](https://github.com/frames-sg/j2k)
compiled to WebAssembly, and draws them as tiles in OpenSeadragon. Think "Cloud
Optimized GeoTIFF" for JPEG 2000.

## Decisions

| Area | Choice |
|---|---|
| Viewer | OpenSeadragon, with a custom tile source |
| Front end | TypeScript + Vite |
| Decoder | `j2k` (pure Rust, MIT/Apache) → `wasm32-unknown-unknown` via `wasm-bindgen` |
| Test encoder | Kakadu (`kdu_compress`) |
| Images | Encode our own in an optimized layout, **and** support existing archive JP2s such as Stanford's, then measure the difference between them |

## What we already know

**j2k as a WASM decoder** (from reading the repo at v0.12.0):
- The core `j2k` crate depends only on `j2k-core`, `j2k-native`, `j2k-types`, `moxcms` and `thiserror`, all pure Rust. It sets `unsafe_code = "forbid"`.
- `rayon` is behind the optional `parallel` feature of `j2k-native`, so a single-threaded WASM build should work without it.
- It already has tile, region and reduced-resolution decode: `decode_tile_scaled_into_in_context` and `decode_region_scaled_into` with `Downscale`.
- It takes a whole `&[u8]`, so the client has to put together a valid codestream before decoding.
- The pinned toolchain is 1.99.0 and only lists native targets, so we have to add `wasm32-unknown-unknown` ourselves.

**Sample existing file:** `bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2` (4.5 MB)
- Server: Stanford stacks. `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`, exposes `Content-Range`, weak ETag.
- Written by Kakadu v7.1. 6000×4000, 3 components, 8-bit, irreversible 9/7, MCT on.
- **One tile (untiled)**, a single tile-part, **RPCL**, 7 quality layers, 5 decomposition levels (6 resolutions).
- Precincts are 256×256 at the two highest resolutions and 128×128 below that. Code blocks are 64×64.
- **No TLM**, but **there is a PLT** (17 KB) in the tile-part header. The main header plus PLT ends at about byte 41.4 KB.
- So every packet can be located from the first ~42 KB. Spatial random access works at the precinct level, though not at the tile level.

## Architecture

```
OpenSeadragon ──(tile x,y,level)──▶ TileSource (TS)
                                       │
                         ┌─────────────┴─────────────┐
                         │ Index (header + TLM/PLT)  │  ← one-time range fetch(es)
                         │ viewport → packet ranges  │
                         └─────────────┬─────────────┘
                                       │ coalesced Range GETs (HTTP/2)
                                       ▼
                             Byte cache (LRU, by range)
                                       │
                                       ▼
                     Codestream synthesizer (main hdr + packets + EOC)
                                       │  postMessage (transferable)
                                       ▼
                       Worker pool → j2k.wasm → RGBA ImageData
```

Two ways to access data, chosen from what the header says:
1. **Tiled files** (our optimized encodes): synthesize `main header + tile-parts for tile T up to resolution r + EOC` and call `decode_tile_scaled`.
2. **Untiled RPCL files with PLT** (archive JP2s): keep the full packet sequence, but swap every packet outside the region of interest for an *empty packet* (one `0x00` byte, since SOP/EPH are off). Then call `decode_region_scaled`. Fall back to fetching the whole resolution prefix when precinct mapping isn't possible.

---

## Phase 0: Project setup
- [x] `git init`, add `.gitignore` (node_modules, target, dist, test images)
- [x] Vite + TypeScript scaffold (`web/`) with Vitest (ESLint/Prettier not added yet)
- [x] Rust workspace for the WASM wrapper (`wasm/`), depending on `j2k` as a git dependency pinned to a commit
- [x] Install `wasm32-unknown-unknown` target, `wasm-bindgen-cli` / `wasm-pack`
- [x] Local static server for test files: a Vite middleware serves `testdata/` at `/testdata/` with `206` Range responses

## Phase 1: Compile j2k to WASM (spike, highest risk)
- [x] `cargo build -p j2k --target wasm32-unknown-unknown`: **builds unmodified** (rayon is compiled in, but we force `CpuDecodeParallelism::Serial`)
- [x] Confirm `j2k-native` and `moxcms` build on wasm32
- [x] Look for platform-specific SIMD (`std::arch` x86/aarch64) and make sure there is a scalar or `wasm32 simd128` fallback
- [x] Thin `wasm-bindgen` wrapper crate (`wasm/src/lib.rs`, on top of `j2k_native::Image::new_with_reduction`, because `j2k::Downscale` stops at 1/8) exposing:
  - [x] `inspect(bytes) -> {width, height, tileCount, bitDepth, hasAlpha}`
  - [x] `decode(bytes, reduction, x, y, w, h) -> RGBA` (any number of levels; region in reduced pixels; w=0 means the whole image)
  - [x] Tiles are decoded by rewriting SIZ to a single-tile image in the codestream synthesizer, so there is no separate tile entry point
- [ ] ~~Reuse one `J2kScratchPool` per worker~~ (we call `j2k_native` directly; its `DecoderContext` is tied to the input buffer's lifetime, so one is created per decode)
- [x] Decode in Node and compare with `kdu_expand` (`wasm/test/compare-kakadu.mjs`, `wasm/test/region.mjs`): max |diff| = 1, about 59 dB PSNR, for the archive file, tiled J2K and tiled HTJ2K
- [x] Decode in a browser (Chromium via Playwright, `web/scripts/screenshot.mjs`)
- [x] Measure `.wasm` size: 544 KB after `wasm-opt -O3`, about 206 KB gzipped
- [x] Benchmark (Node 26, M-series, single thread, 1024² at full resolution): archive untiled J2K 225–257 ms, tiled-1024 J2K 108–115 ms, tiled-1024 HTJ2K 79–84 ms, 512² HTJ2K 34 ms. `+simd128` is about 5–12% faster and is now the default
- [x] Note: a full-resolution decode of the whole 24 MP image fails the j2k decode budget ("image is too large"). That's fine because we only decode tiles
- [ ] Optional: threaded build (`wasm-bindgen-rayon`, which needs COOP/COEP headers). Only do this if single-threaded workers aren't fast enough.
- [x] **Go/no-go: GO.** j2k works as the decoder. if j2k doesn't build or is too slow, fall back to OpenJPEG (openjpegjs) or OpenJPH for HTJ2K

## Phase 2: Header parser and index (TypeScript)
- [x] JP2/JPH box parser (`web/src/jp2/boxes.ts`): signature, XL boxes, `jp2c` length 0. `jp2h` is not interpreted yet; we decode raw codestreams
- [x] Main header parser (`web/src/jp2/codestream.ts`): SIZ, COD/COC, TLM, plus detecting POC/PPM as unsupported (QCD/CAP/COM are passed through untouched)
- [x] Progressive header fetch: start with 64 KB, and extend if the main header or first tile-part header (PLT) runs past it
- [x] Tile-part header parser: SOT, PLT. Files with PPT/POC or COD/COC in tile-part headers fall back to tile access
- [x] Build a **packet index** from PLT for single-tile files (`Jp2Image.buildPacketIndex`), checked against the packet count the geometry predicts
- [x] Precinct geometry: compute precinct and code-block bounds per resolution, accounting for image/tile offsets (the spec's ceil-division rules)
- [x] Map a region to packets: given a full-resolution rect and a resolution r, return the packets needed for levels 0..r
- [x] Unit tests against Kakadu-produced fixtures (`web/test/*.test.ts`)
- [ ] Optional: export the index as a sidecar JSON/binary file for files whose PLT is very large

## Phase 3: Fetching and caching
- [x] `HttpRangeSource` (`web/src/net/range-source.ts`): checks `206`/`Content-Range` and falls back to caching the whole body on `200`. It compares ETags rather than sending `If-Range`, because `If-Range` would force a CORS preflight; see `docs/stacks-recommendations.md`
- [x] Coalesce adjacent or nearby ranges (configurable gap, for example 4–16 KB) into one request
- [x] Limit concurrency (6). Aborted tiles skip decoding, but shared fetches are deliberately not cancelled
- [x] LRU span cache with a byte budget (256 MB), deduplicating in-flight requests
- [x] Count requests and bytes, for the HUD and the benchmarks

## Phase 4: Codestream synthesis
- [x] Tiled path: main header (without TLM/PLM) + SIZ cropped to the needed tiles (renumbered) + tile-parts up to resolution r + EOC. One codestream can cover several JP2 tiles
- [x] Untiled path: main header + a single SOT, with PLT removed + the packet stream where packets we don't need become `0x00` + EOC. Packets of resolutions above r are cut off in RPCL/RLCP
- [x] Handle SOP/EPH markers if present (then the empty packet needs `FF91` and `FF92` around it)
- [ ] Handle quality layers: optionally fetch only the first N layers for a fast first view, then refine
- [x] Tests: synthesized region decode vs full-file region decode is **bit-exact** for all 6 fixtures × 7 regions (`web/test/decode.test.ts`)

## Phase 5: Decode workers
- [x] Worker pool sized to `hardwareConcurrency - 1` (max 8), one WASM instance each
- [x] Codestream is transferred to the worker and the decoded `ImageBitmap` is transferred back
- [ ] Queue tiles by priority (FIFO for now; OSD already requests in priority order, and queued jobs are dropped on abort)
- [x] Turn the RGBA into an `ImageBitmap` in the worker, falling back to a canvas `context2d`

## Phase 6: OpenSeadragon integration
- [x] Custom `TileSource` (`web/src/viewer/tile-source.ts`): the OSD tile size is the JP2 tile size (256–1024), or 512 for untiled files
- [x] Map OpenSeadragon levels to JP2 resolution reductions (any number of levels, not just j2k's `Downscale`)
- [x] Use `downloadTileStart` / `downloadTileAbort` with the fetcher + worker, and render through `context2d` / `ImageBitmap`
- [ ] Handle edge tiles and odd sizes (done and tested); non-zero image offsets are untested
- [x] Debug HUD: file structure, open cost, requests, bytes fetched vs file size, average decode time (no cache hit rate yet)
- [x] URL parameter `?src=` to open any CORS-enabled JP2. **Works against stacks.stanford.edu today with no server changes**

## Phase 7: Test images (Kakadu)
- [x] Large archive sample: `kp368nb7707_0001.jp2`, a 1.2 GB piano roll (4096×252840, Kakadu 7.1, untiled, RPCL, 13 layers, 1.49 MB of PLT, 975k packets). Keep the 6000×4000 Stanford file as the small baseline
- [ ] Encode a matrix of variants, all with `ORGgen_plt=yes ORGgen_tlm=… ORGtparts=R Corder=RPCL`:
  - [x] Classic J2K, tiled `Stiles={1024,1024}`
  - [x] Classic J2K, tiled `Stiles={512,512}`
  - [x] Classic J2K, untiled with `Cprecincts={256,256}` (like the archive files)
  - [x] HTJ2K (`Cmodes=HT`), tiled 1024 and 512, written as `.jph`
  - [x] Lossless HTJ2K tiled 1024 (`-t1024-lossless-ht.jph`); lossy variants use `-rate 1.5`
  - [ ] Varying `Clayers` (1 vs 7) and `Clevels` (enough that the smallest level fits in one tile)
- [ ] Re-encode the Stanford JP2's source (or transcode the JP2 itself) into the best layout, so we can compare the same image both ways
- [x] Script it (`scripts/encode-variants.sh`) and record the exact `kdu_compress` command lines
- [x] Check each output with our parser (tests assert TLM, resolution tile-parts and the access mode)

## Phase 8: Benchmark — existing JP2s vs optimized layout
- [ ] Repeatable test: open the viewer, load the overview, zoom to 3 fixed points at 3 levels, pan, recorded with Playwright
- [ ] Measure for each variant:
  - [ ] Bytes and requests before the first image appears (header + index + overview)
  - [ ] Time to first image and time until the viewport is sharp
  - [ ] Total bytes and requests for the whole test, and the overfetch ratio (bytes fetched ÷ bytes decoded)
  - [ ] Average and p95 decode time per tile (J2K vs HTJ2K)
  - [ ] File size, and PSNR compared with the original
- [ ] Run against Stanford stacks (Apache, HTTP/2), local, and an object store / CDN (S3 + CloudFront or similar)
- [ ] Write up the difference in `docs/benchmark.md`, including a recommended "cloud-optimized JP2" encoding profile

## Phase 9: Hardening and stretch goals
- [x] Other progression orders (LRCP, RLCP, PCRL, CPRL) when indexing packets (implemented in `packetOrder`, but only RPCL is covered by fixtures)
- [ ] Files without PLT: fall back to scanning packet headers, or fetching whole resolution prefixes
- [ ] 16-bit and greyscale images, palette (`pclr`/`cmap`), ICC colour via `moxcms`
- [ ] Progressive quality: show the first layers right away, then refine
- [ ] Optional IIIF Image API facade (`info.json` generated in the client) so existing IIIF viewers can use it
- [ ] Packaging: publish the TileSource + worker + wasm as an npm package
- [ ] CI: build the Rust/WASM and web code, run unit tests, and run a Playwright smoke test on a small fixture

- [x] Stacks server recommendations: `docs/stacks-recommendations.md`

## Phase 2b: Very large untiled files (from the piano roll)
- [x] Opening: 8 requests, 2 MB (header + PLT), about 1.1–1.7 s against Stacks
- [x] Packet index in typed arrays, with no allocation per packet (`forEachPacket`)
- [x] **Level dropping** (`web/src/jp2/rewrite.ts`): synthesize the codestream on the reduced canvas with NL−d levels (SIZ, COD/COC, QCD/QCC rewritten) and reuse the packets unchanged. Needed because j2k allocates coefficients for the full-resolution tile even when skipping levels. Used by both access paths
- [x] **Virtual tiles** for untiled files: crop to a window around the region, aligned to every kept resolution's precinct grid, with a wavelet-support margin of 2^(levels+3)
- [x] Matches `kdu_expand -region` within ±1 at reductions 0–5, including regions at window boundaries and at the end of the image (`web/test/kakadu.test.ts`)
- [x] ~~Vendored j2k with a one-line patch raising the decode budget to 1.5 GiB~~ (dropped after re-pinning to j2k main `d849d62a`). Full-resolution windows in this file are 4096×4096 to 4096×8192 because of its 128-px precincts at 1/32 resolution (4096 rows), peaking at about 430 MB natively
- [x] Large decodes (> 8 M samples) go to one dedicated worker, so only one WASM instance grows
- [x] Upstream j2k, region-sized memory: covered by PRs [#129](https://github.com/frames-sg/j2k/pull/129) (coefficients sized to the ROI) and [#131](https://github.com/frames-sg/j2k/pull/131) (build/parse only the needed precincts), with [#133](https://github.com/frames-sg/j2k/issues/133) proposing line-based decode. With #131, our windowed piano-roll decodes fit the stock 512 MB budget at **9–50 MB peak RSS**, down from 222–1,043 MB. Both merged; re-pinned to `d849d62a` and dropped the budget patch. In WASM (Node, simd128) the memory high-water mark over the test regions fell from 694 MB to 124 MB (33 MB for tile-sized decodes), and decodes are 3–25% faster. The `.wasm` grew from 205 KB to 263 KB gzipped
- [ ] Remove the dedicated large worker now that every decode fits the stock budget
- [ ] Enable the streamed region IDWT (#182) once j2k exposes `set_line_region_idwt` publicly
- [x] Upstream j2k, [#134](https://github.com/frames-sg/j2k/issues/134): `MAX_J2K_IMAGE_DIMENSION` (60,000 px) rejected the 4096×252840 roll at SIZ parse time. Lifted by #173, so virtual-tile windowing is now an optimization (smaller synthesized codestreams), not a requirement
- [ ] Viewer: a larger OSD tile at the finest level for untiled files, to amortize the 4096-wide window per decode

## Open questions / risks
- Does j2k build for wasm32 as-is, and does it decode the synthesized codestreams (with empty packets) correctly?
- Decode speed for classic J2K in WASM without threads. HTJ2K is the likely fix if it's slow.
- Is a 256×256 precinct size too fine (many small requests) or too coarse (overfetch) on real networks?
- Is Kakadu available on our build machine, and does the license allow us to publish benchmark files encoded with it?
- Stanford stacks sends `cache-control: private` and a weak ETag, which limits CDN and `If-Range` behaviour. Note this in the benchmark.
