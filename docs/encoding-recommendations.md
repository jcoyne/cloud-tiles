# Encoding JP2s for range-request viewing

Which `kdu_compress` options make a JP2 fast to view with this project, and
what that means for SDR's derivative pipeline
([`sul-dlss/assembly-image` `jp2_creator.rb`](https://github.com/sul-dlss/assembly-image/blob/main/lib/assembly/image/jp2_creator.rb#L66-L92)).

**Short version:** `ORGgen_plt=yes` is the one option this viewer can't do
without on untiled files, and SDR dropped it in 2022. Restore it. Tiling with
one tile-part per resolution and a TLM index is the next step up.

## How this was measured

Every variant was encoded with Kakadu 8.4.1 from the same source,
`stanford-army.tif` (6000×4000, RGB, 8-bit; see
[`testdata/README.md`](../testdata/README.md)). Each one went through the same
simulated viewer session, using the real parser, range source and WASM decoder:

1. open the file;
2. load the overview (the coarsest level at least 1536 px wide; 1/4 here);
3. zoom to three points at 1/4, 1/2 and full resolution, with a 1536×1024
   viewport, fetching each viewport's tiles together (the 8 KB gap
   coalescing is on).

The files were local, so request counts are exact but carry no latency. Over
HTTP, request count matters more than it does here. On an image this small,
three zooms cover much of it, so "% of file" runs high. The differences grow
on large images.

## What each option does for this viewer

Each row changes one setting from a baseline: 7 layers, RPCL, 64×64 code
blocks and `-rate 1.5`. Tiled rows use 512×512 tiles, `ORGtparts=R`, TLM, PLT
and HT; untiled rows use 256×256 precincts with PLT.

| Variant | Opening (requests / KB) | First view | Whole session | % of file | ms per 512 tile |
|---|---|---|---|---|---|
| **Untiled** RPCL, PLT | 3 / 88 | 21 / 1,316 | 145 / 3,510 | 79% | 77 |
| untiled, **no PLT** | 3 / 88 | 4 / 4,403 | 4 / 4,403 | **100%** | 81 |
| untiled, PCRL | 3 / 88 | 50 / 1,335 | 261 / 3,683 | 83% | 78 |
| untiled, CPRL | 3 / 88 | 51 / 1,379 | 402 / 3,612 | 82% | 79 |
| untiled, RLCP | 3 / 88 | 94 / 1,312 | 692 / 3,560 | 81% | 77 |
| untiled, LRCP | 3 / 88 | 112 / 1,320 | 859 / 3,571 | 81% | 78 |
| untiled, 128 precincts | 3 / 88 | 45 / 1,304 | 281 / 3,312 | 75% | 69 |
| untiled, 512 precincts | 3 / 88 | 9 / 1,314 | 67 / 3,808 | 86% | 82 |
| untiled, HT | 3 / 88 | 21 / 1,305 | 145 / 3,506 | 79% | 21 |
| **Tiled** 512, HT | 1 / 64 | 81 / 1,345 | 154 / 3,108 | 71% | 12 |
| tiled, no PLT | 1 / 64 | 81 / 1,341 | 155 / 3,101 | 71% | 12 |
| tiled, **no TLM** | **867 / 1,705** | 911 / 2,442 | 982 / 3,910 | 89% | 12 |
| tiled, **one tile-part per tile** | 1 / 64 | 26 / 4,385 | 26 / 4,385 | **100%** | 13 |
| tiled, LRCP | 1 / 64 | 131 / 4,399 | 131 / 4,399 | **100%** | 12 |
| tiled, 256 tiles | 1 / 64 | 295 / 1,461 | 530 / 2,907 | 65% | 3.4 (256 tile) |
| tiled, 1024 tiles | 1 / 64 | 27 / 1,314 | 53 / 3,601 | 82% | 44 (1024 tile) |
| tiled, classic (not HT), 7 layers | 1 / 64 | 81 / 1,323 | 155 / 3,085 | 70% | 26 |
| tiled, classic, 1 layer | 1 / 64 | 81 / 1,325 | 154 / 3,095 | 70% | 26 |

What this shows:

- **PLT** is required for untiled files. Without it the viewer can't locate
  packets and downloads the whole file. Tiled files with TLM don't use it;
  it costs about 0.3% of the file, and other readers can use it.
- **TLM** and **`ORGtparts=R`** are required for tiled files. TLM lets the
  viewer open the file in one read. One tile-part per resolution lets it fetch
  a zoom level without the finer ones.
- **RPCL** is the right progression order. In untiled files the other orders
  move about the same bytes in 2–6× the requests. In tiled files, LRCP breaks
  per-resolution access.
- **HTJ2K** decodes 2–4× faster than classic J2K in our WASM decoder.
- **Tiled** decodes are about 3× faster than untiled ones at the same output
  size. An untiled decode has to include extra margin around each region for
  the wavelet transform.
- **512** is the best tile size. 256 needs 3.4× the requests; 1024 reads 16%
  more bytes.
- **Quality layers** make no difference yet, because the viewer always reads
  every layer.

## SDR's current settings

`jp2_creator.rb` runs:

```
kdu_compress [-jp2_space sRGB] -num_threads 2 -quiet Creversible=no Corder=RPCL
  Cblk={64,64} Cprecincts={256,256},{256,256},{128,128} -rate - Clevels=5 Clayers=<n>
```

[PR #65](https://github.com/sul-dlss/assembly-image/pull/65) (merged
2022-06-27, the move from ImageMagick to libvips) dropped
`ORGgen_plt=yes` and changed `-rate 1.5` to `-rate -`. The PR doesn't say why.
JP2s made since then have **no PLT**. Older files, such as `bb002wb0348`
(2014), have it.

The same source encoded with these settings, then with each proposed change
(`-rate -` throughout, so only the layout differs):

| Settings | File size | First view (requests / KB) | Whole session | ms per 512 tile |
|---|---|---|---|---|
| current | 5,062 KB | 4 / 4,943 (the whole file) | 4 / 4,943 | 96 |
| + `ORGgen_plt=yes` | 5,079 KB (+0.3%) | 45 / 1,700 | 169 / 4,032 | 84 |
| + 512 tiles, `ORGtparts=R`, `ORGgen_tlm=6` | 5,483 KB (+8%) | 82 / 1,767 | 155 / 3,870 | 33 |
| + `Cmodes=HT` | 7,137 KB (+41%) | 89 / 1,928 | 162 / 4,766 | 12 |

## Recommended changes to `jp2_creator.rb`

### 1. Restore PLT (do now)

```diff
         '-rate -', # Ratio of compressed bits to the image size
+        'ORGgen_plt=yes', # Insert packet length information
         'Clevels=5' # Number of wavelet decomposition levels, or stages
```

The file grows by 0.3%, and the pixels are unchanged. Files keep the layout
that the pre-2022 JP2s already have. In this test, the first view drops from
the whole 4.9 MB file to 1.7 MB.

### 2. Tile with an index (worth evaluating)

```diff
+        'Stiles=\\{512,512\\}', # 512x512 tiles
+        'ORGtparts=R', # One tile-part per resolution level
+        'ORGgen_tlm=6', # Tile-part index in the main header; one entry per tile-part (Clevels + 1)
```

Decodes get 2.5× faster and less data moves. The costs:

- Files are about 8% larger with `-rate -`. With `-rate 1.5` the gap
  disappeared (4,522 KB tiled vs 4,528 KB untiled).
- It changes the layout that every other reader sees, including the Stacks
  IIIF image server. Kakadu-based servers generally handle tiled files well,
  but measure that server before switching.
- `ORGgen_tlm` must be `Clevels + 1`. Update both together if `Clevels`
  changes.

### 3. HTJ2K (not yet)

HT gives the fastest decodes, but:

- encoding needs Kakadu 8 or later;
- every downstream reader must support JPEG 2000 Part 15;
- Kakadu wants a `.jph` extension;
- with `-rate -`, the file grows by another 30%.

Revisit this alongside the `-rate` question.

### Not changed

`Clayers`, `Cblk`, `Corder=RPCL` and `Cprecincts` are already right for
untiled files. `-num_threads` only affects encoding. Whether to go back to
`-rate 1.5` is a fidelity decision, separate from layout: in this test
`-rate -` made the file 11% larger than the 2014 original.

## Adding PLT to existing files without re-encoding

`kdu_transcode` can add PLT by rewriting the codestream packets losslessly, but it
only writes raw codestreams or JPX. So:

1. transcode to a raw codestream:

   ```
   kdu_transcode -i in.jp2 -o cs.j2c ORGgen_plt=yes Corder=RPCL
   ```

2. replace the original file's `jp2c` box with `cs.j2c`, keeping every other
   box (signature, `ftyp`, `jp2h`, metadata).

On the test file, the result decoded to identical pixels at full resolution
with `kdu_expand`. It kept its JP2 file type and sRGB colour spec, and grew by
the expected 0.3%. Tiling can't be added this way: `kdu_transcode` rejects
`Stiles`, so tiling needs a full re-encode.
