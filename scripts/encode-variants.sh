#!/usr/bin/env bash
# Encode test variants of a source image with Kakadu in range-request-friendly layouts.
# Usage: scripts/encode-variants.sh <source.tif> <out-dir> [rate-bpp]
set -euo pipefail

src=${1:?source image}
out=${2:?output directory}
rate=${3:-1.5}
name=$(basename "${src%.*}")
mkdir -p "$out"

# Common: RPCL, one tile-part per resolution, PLT in every tile-part, TLM in the main header.
levels=6
common=(Corder=RPCL ORGtparts=R ORGgen_plt=yes "ORGgen_tlm=$((levels + 1))" "Clevels=$levels" 'Cblk={64,64}')

enc() {
  local file=$1; shift
  echo "== $file"
  kdu_compress -quiet -i "$src" -o "$out/$file" "${common[@]}" "$@"
  ls -l "$out/$file" | awk '{print $5, $9}'
}

enc "$name-t1024-j2k.jp2"   'Stiles={1024,1024}' Clayers=7 -rate "$rate"
enc "$name-t512-j2k.jp2"    'Stiles={512,512}'   Clayers=7 -rate "$rate"
enc "$name-t1024-ht.jph"    'Stiles={1024,1024}' Cmodes=HT -rate "$rate"
enc "$name-t512-ht.jph"     'Stiles={512,512}'   Cmodes=HT -rate "$rate"
enc "$name-p256-j2k.jp2"    'Cprecincts={256,256}' Clayers=7 -rate "$rate"
enc "$name-t1024-lossless-ht.jph" 'Stiles={1024,1024}' Cmodes=HT Creversible=yes
