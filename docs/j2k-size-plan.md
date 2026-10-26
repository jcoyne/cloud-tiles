# Plan: a smaller j2k decoder for WASM

The `.wasm` grew from 263 KB to 312 KB gzipped when we re-pinned j2k to
`30848511`. This plan asks whether we should carve a decode-only crate out of
j2k to shrink it, and what to do instead.

**Short version:** don't split the crate. The binary already contains only the
decode code we reach. LTO removes everything else, encode included (0.1 KB of
it survives). The size comes from code that is *reachable* but never used in
our build: rayon and j2k's parallel decode paths, plus profiling
instrumentation. Cargo features remove both and leave speed unchanged:

| Build | Raw | Gzipped | vs today |
|---|---|---|---|
| previous pin `d849d62a` | 692 KB | 263 KB | |
| **today**: `30848511`, default features | 846 KB | 312 KB | |
| Step 1: `default-features = false, features = ["std", "simd"]` | 634 KB | 232 KB | −26% |
| Step 2: also compile out profiling (prototype) | 597 KB | 215 KB | −31% |
| **now**: `8becfd9f` (0.13.0), steps 1 and 2 | 593 KB | 217 KB | −30% |

All builds use simd128, then `wasm-bindgen` and `wasm-opt -O3`, as in
`wasm/build.sh`. The test suite passes on each (59 tests, plus the 10 Kakadu
comparisons for step 1). Decode time over the 7 benchmark regions was 326–338 ms
for all three builds, across four alternating runs.

## Where the bytes are

Attribution comes from `twiggy` on the pre-`wasm-bindgen` binary (raw bytes, not
counting the name section), grouped by module:

| Module | `d849d62a` | `30848511` | Without `parallel` |
|---|---|---|---|
| `rayon`, `rayon_core`, `crossbeam_*` | 65 KB | 75 KB | 0 |
| j2k parallel decode (`decode::subband::parallel`, `tile_parallel`, …) | — | ~40 KB | 0 |
| `idwt` (banded, streamed, fused last level) | 51 KB | 96 KB | 99 KB |
| `fearless_simd` kernels | 0* | 53 KB | 3 KB* |
| `.rodata` (HT lookup tables and others) | 46 KB | 65 KB | 62 KB |
| profiling (`j2k_profile`, `emit_profile_row`) | 20 KB | 28 KB | 28 KB |
| HT block decode | 60 KB | 65 KB | 52 KB |
| classic tier-1 (`bitplane`) | 39 KB | 39 KB | 39 KB |
| everything else | | | |
| **Total** | **736 KB** | **889 KB** | **670 KB** |

\* Where these functions end up depends on inlining. In some builds they're
counted under the j2k modules that call them.

What this shows:

- **About half of the growth is unused parallelism.** We set
  `CpuDecodeParallelism::Serial`, but that's a runtime choice, so rayon and the
  parallel code paths stay reachable and get linked in. The `parallel` feature
  is on by default.
- **The rest is real decode work**: the streamed region IDWT (#182/#188),
  the fused last-level pack, new SIMD kernels, and the HT lookup tables
  (#211–#214). These are the code paths our decodes run, so they're the price
  of the memory and speed work.
- **Nothing for encode, Metal, CUDA or transcoding is in the binary.**
  Rearranging crates wouldn't change what the linker keeps.

## Why not a decode-only crate

A split would help other things, such as compile time, the size of the
dependency tree, and how readable the API is. It wouldn't shrink the binary,
which is what we care about. The cost would be real: `j2k-native`'s encode and
decode share their codestream, tile, progression and math modules. Upstream
would have to keep a crate boundary through code that's changing fast (35 merged
PRs in the last pin bump alone). That's a lot to ask for no size win.

## Step 1: turn off `parallel` (us, no upstream change) — done

```diff
-j2k-native = { path = "vendor/j2k/crates/j2k-native" }
+# Without `parallel`: we always decode serially, and rayon adds ~80 KB gzipped.
+j2k-native = { path = "vendor/j2k/crates/j2k-native", default-features = false, features = ["std", "simd"] }
```

`CpuDecodeParallelism::Serial` becomes the only behaviour, so the
`set_cpu_decode_parallelism` call in `wasm/src/lib.rs` can stay or go.

Risk: upstream CI never builds this combination. It checks
`--no-default-features` only for `j2k-types` and `j2k-codec-math`, and has no
wasm32 target. A future upstream change could break it without anyone
noticing. That's what step 3 addresses.

## Step 2: a `profile` feature (ask upstream) — done

Status: [frames-sg/j2k#252](https://github.com/frames-sg/j2k/issues/252), merged as PR [#255](https://github.com/frames-sg/j2k/pull/255). Our dependency line already leaves the feature out, so pinning `8becfd9f` (0.13.0) gives 593 KB raw, 217 KB gzipped, with no profiling symbols in the binary.

Profiling is compiled in whenever `std` is on, and switched on at runtime by an
environment variable. A browser never sets one. All of it sits in
`crates/j2k-native/src/profile.rs`, behind `cfg(feature = "std")`. The
prototype:

1. In `profile.rs`, replace `feature = "std"` with `feature = "profile"`.
2. Add `profile = ["std"]` to `j2k-native`'s `[features]`, and to `default`,
   so nothing changes for existing users.

It built and passed our tests unchanged, and saved 16.5 KB gzipped. Upstream
may want a different name, or `j2k-profile` gated the same way.

## Step 3: CI coverage for the WASM build (ask upstream) — done

Status: [frames-sg/j2k#253](https://github.com/frames-sg/j2k/issues/253), merged as PR [#254](https://github.com/frames-sg/j2k/pull/254). The PR adds the check to `cargo xtask no-std`, which runs on pushes to `main` rather than on PRs. It also fixes four tests that didn't compile without `parallel`.

One job, so steps 1 and 2 keep working:

```yaml
- run: rustup target add wasm32-unknown-unknown
- run: cargo check -p j2k-native --target wasm32-unknown-unknown --no-default-features --features std,simd
```

A size budget for the same build would catch regressions like this one, but
that's for the maintainer to decide.

## Not worth pursuing

- **Feature-gating colour conversions** (palette, ICC, sYCC, CIELab): under
  1 KB in total.
- **Dropping classic tier-1** for HT-only builds: 39 KB, but the SDR archive
  is classic J2K.
- **Dropping IDWT fallbacks**: the whole-window path is what decodes palette,
  sYCC, subsampled components and other cases the streamed IDWT doesn't
  cover.
- **Replacing error strings with codes**: formatting is about 20 KB, but it
  would make every error opaque. Leave it.

## Draft upstream issue

> **Title:** Feature to compile out profiling, and CI for a serial wasm32 build
>
> We use `j2k-native` in a browser viewer (wasm32, single-threaded, with
> `CpuDecodeParallelism::Serial`). With
> `default-features = false, features = ["std", "simd"]` our decoder is
> 232 KB gzipped, down from 312 KB with default features, and decodes at the
> same speed.
>
> Two small requests:
>
> 1. **A `profile` feature** (on by default) for `profile.rs`, which is
>    currently gated on `std`. Profiling can't be turned on in a browser, and
>    compiling it out saves another 16.5 KB gzipped (7%). We prototyped it as a
>    rename of the `cfg` in that file plus `profile = ["std"]`, and are happy
>    to send a PR.
> 2. **A CI check** for
>    `cargo check -p j2k-native --target wasm32-unknown-unknown --no-default-features --features std,simd`,
>    so the serial wasm build keeps compiling.
>
> We considered asking for a decode-only crate, but LTO already removes all
> encode code from our binary, so it wouldn't help us. Would you take either
> of these?
