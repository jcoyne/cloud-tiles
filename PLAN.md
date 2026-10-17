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
- [ ] Vite + TypeScript scaffold (`web/`), with ESLint/Prettier and Vitest
- [x] Rust workspace for the WASM wrapper (`wasm/`), depending on `j2k` as a git dependency pinned to a commit
- [x] Install `wasm32-unknown-unknown` target, `wasm-bindgen-cli` / `wasm-pack`
- [ ] Local static server for test files that supports Range and CORS (Vite's static serving, or a small `http-server` config). Confirm it returns `206`.

## Phase 1: Compile j2k to WASM (spike, highest risk)
- [x] `cargo build -p j2k --target wasm32-unknown-unknown`: **builds unmodified** (rayon is compiled in, but we force `CpuDecodeParallelism::Serial`)
- [x] Confirm `j2k-native` and `moxcms` build on wasm32
- [x] Look for platform-specific SIMD (`std::arch` x86/aarch64) and make sure there is a scalar or `wasm32 simd128` fallback
- [x] Thin `wasm-bindgen` wrapper crate (`wasm/src/lib.rs`, on top of `j2k_native::Image::new_with_reduction`, because `j2k::Downscale` stops at 1/8) exposing:
  - [x] `inspect(bytes) -> {width, height, tileCount, bitDepth, hasAlpha}`
  - [x] `decode(bytes, reduction, x, y, w, h) -> RGBA` (any number of levels; region in reduced pixels; w=0 means the whole image)
  - [x] Tiles are decoded by rewriting SIZ to a single-tile image in the codestream synthesizer, so there is no separate tile entry point
- [ ] Reuse one `J2kScratchPool` per worker, so we don't allocate for every tile
- [x] Decode in Node and compare with `kdu_expand` (`wasm/test/compare-kakadu.mjs`, `wasm/test/region.mjs`): max |diff| = 1, about 59 dB PSNR, for the archive file, tiled J2K and tiled HTJ2K
- [ ] Decode in a browser (see Phase 6)
- [x] Measure `.wasm` size: 544 KB after `wasm-opt -O3`, about 206 KB gzipped
- [x] Benchmark (Node 26, M-series, single thread, 1024² at full resolution): archive untiled J2K 225–257 ms, tiled-1024 J2K 108–115 ms, tiled-1024 HTJ2K 79–84 ms, 512² HTJ2K 34 ms. `+simd128` is about 5–12% faster and is now the default
- [ ] Note: a full-resolution decode of the whole 24 MP image fails the j2k decode budget ("image is too large"). That's fine because we only decode tiles
- [ ] Optional: threaded build (`wasm-bindgen-rayon`, which needs COOP/COEP headers). Only do this if single-threaded workers aren't fast enough.
- [x] **Go/no-go: GO.** j2k works as the decoder. if j2k doesn't build or is too slow, fall back to OpenJPEG (openjpegjs) or OpenJPH for HTJ2K

## Phase 2: Header parser and index (TypeScript)
- [ ] JP2/JPH box parser: `jP  `, `ftyp`, `jp2h` (`ihdr`, `colr`, `pclr`, `cmap`, `res `), `uuid`, `jp2c`, XL boxes, and `jp2c` length 0 (meaning "to end of file")
- [ ] Main header parser: SIZ, CAP, COD/COC, QCD/QCC, TLM, PLM, PPM, COM
- [ ] Progressive header fetch: start with 64 KB, and extend if the main header or first tile-part header (PLT) runs past it
- [ ] Tile-part header parser: SOT, PLT, PPT, and COD/QCD overrides
- [ ] Build a **packet index**: for each (tile, resolution, component, layer, precinct), its byte offset and length. Use TLM for tile-parts and PLT for packets, following the progression order (start with RPCL, add others later)
- [ ] Precinct geometry: compute precinct and code-block bounds per resolution, accounting for image/tile offsets (the spec's ceil-division rules)
- [ ] Map a region to packets: given a full-resolution rect and a resolution r, return the packets needed for levels 0..r
- [ ] Unit tests against Kakadu-produced fixtures, checked against `kdu_expand -record` / `j2k inspect` output
- [ ] Optional: export the index as a sidecar JSON/binary file for files whose PLT is very large

## Phase 3: Fetching and caching
- [ ] `RangeFetcher`: `fetch` with `Range: bytes=a-b`, check for `206` and `Content-Range`, use `If-Range` with the ETag to detect the file changing underneath us
- [ ] Coalesce adjacent or nearby ranges (configurable gap, for example 4–16 KB) into one request
- [ ] Limit concurrency and cancel with `AbortController` when OpenSeadragon drops a tile
- [ ] LRU byte cache keyed by range, with a memory cap. Low resolutions are shared by every view, so keep those cached.
- [ ] Count requests and bytes, for the HUD and the benchmarks

## Phase 4: Codestream synthesis
- [ ] Tiled path: main header (without TLM/PLM) + SOT/tile-part(s) for the tile, with Psot fixed up and truncated to resolution r + EOC
- [ ] Untiled path: main header + a single SOT, with PLT removed + the packet stream where packets we don't need become `0x00` + EOC
- [ ] Handle SOP/EPH markers if present (then the empty packet needs `FF91` and `FF92` around it)
- [ ] Handle quality layers: optionally fetch only the first N layers for a fast first view, then refine
- [ ] Tests: compare the synthesized region decode with a crop of the full decode (bit-exact for lossless, within tolerance for lossy)

## Phase 5: Decode workers
- [ ] Worker pool sized to `navigator.hardwareConcurrency - 1`, each with its own WASM instance
- [ ] Pass bytes in and RGBA out as transferable `ArrayBuffer`s, with no copies
- [ ] Queue tiles by priority (closest to the viewport centre and coarsest level first), and drop jobs that are no longer needed
- [ ] Turn the RGBA into an `ImageBitmap` in the worker if supported, otherwise into `ImageData`

## Phase 6: OpenSeadragon integration
- [ ] Custom `TileSource`: `width/height` from SIZ, `tileSize` from the JP2 tile size (or a virtual 512/1024 tile for untiled files), `maxLevel` from the decomposition levels
- [ ] Map OpenSeadragon levels to JP2 resolution levels, and pick a `Downscale` (j2k only reduces by powers of two, which matches)
- [ ] Use `downloadTileStart` / `downloadTileAbort` with the fetcher + worker, and render through `context2d` / `ImageBitmap`
- [ ] Handle edge tiles, odd sizes and non-zero image offsets
- [ ] Debug HUD: requests, bytes fetched vs file size, decode time per tile, cache hit rate
- [ ] URL parameter `?src=` to open any CORS-enabled JP2

## Phase 7: Test images (Kakadu)
- [ ] Get a large source image (at least 30k×30k, for example a pathology slide or aerial mosaic) and keep the Stanford file as the "existing" baseline
- [ ] Encode a matrix of variants, all with `ORGgen_plt=yes ORGgen_tlm=… ORGtparts=R Corder=RPCL`:
  - [ ] Classic J2K, tiled `Stiles={1024,1024}`
  - [ ] Classic J2K, tiled `Stiles={512,512}`
  - [ ] Classic J2K, untiled with `Cprecincts={256,256}` (like the archive files)
  - [ ] HTJ2K (`Cmodes=HT`), tiled 1024 and 512, written as `.jph`
  - [ ] Lossless (`Creversible=yes`) vs lossy (`Qstep` / `-rate`) for each
  - [ ] Varying `Clayers` (1 vs 7) and `Clevels` (enough that the smallest level fits in one tile)
- [ ] Re-encode the Stanford JP2's source (or transcode the JP2 itself) into the best layout, so we can compare the same image both ways
- [ ] Script it (`scripts/encode-variants.sh`) and record the exact `kdu_compress` command lines
- [ ] Check each output with `j2k inspect` and our parser (that TLM/PLT are present and the progression order is right)

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
- [ ] Other progression orders (LRCP, RLCP, PCRL, CPRL) when indexing packets
- [ ] Files without PLT: fall back to scanning packet headers, or fetching whole resolution prefixes
- [ ] 16-bit and greyscale images, palette (`pclr`/`cmap`), ICC colour via `moxcms`
- [ ] Progressive quality: show the first layers right away, then refine
- [ ] Optional IIIF Image API facade (`info.json` generated in the client) so existing IIIF viewers can use it
- [ ] Packaging: publish the TileSource + worker + wasm as an npm package
- [ ] CI: build the Rust/WASM and web code, run unit tests, and run a Playwright smoke test on a small fixture

## Open questions / risks
- Does j2k build for wasm32 as-is, and does it decode the synthesized codestreams (with empty packets) correctly?
- Decode speed for classic J2K in WASM without threads. HTJ2K is the likely fix if it's slow.
- Is a 256×256 precinct size too fine (many small requests) or too coarse (overfetch) on real networks?
- Is Kakadu available on our build machine, and does the license allow us to publish benchmark files encoded with it?
- Stanford stacks sends `cache-control: private` and a weak ETag, which limits CDN and `If-Range` behaviour. Note this in the benchmark.
