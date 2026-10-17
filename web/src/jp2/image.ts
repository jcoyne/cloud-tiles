/**
 * A remote JPEG 2000 image addressed by byte ranges.
 *
 * `Jp2Image.open` reads only the file header, main header, and tile-part
 * headers it needs. `plan()` then maps a region at some resolution to the byte
 * ranges to fetch and a function that synthesizes a small valid codestream
 * from those bytes for the WASM decoder.
 *
 * Two access strategies:
 * - "tiles": multi-tile files. Crop SIZ to the needed tiles, renumber them,
 *   and drop tile-parts above the target resolution (when tile-parts are
 *   split by resolution).
 * - "precincts": single-tile files with PLT. Keep the whole packet sequence
 *   but replace packets outside the region with empty packets.
 */

import { NeedMoreData, parseFileLayout, type FileLayout } from "./boxes";
import { Marker, parseMainHeader, parseTilePartHeader, type MainHeader, type TilePartHeader } from "./codestream";
import { rewriteMainHeader, rewrittenHeader, type SizFields } from "./rewrite";
import { ceilDiv, forEachPacket, intersects, precinctRect, resolution, tileRect, type Rect } from "./geometry";

export interface ByteSource {
  /** Total size in bytes. */
  size(): Promise<number>;
  /** Read absolute `[start, end)`; resolves with exactly those bytes (clamped to EOF). */
  read(start: number, end: number): Promise<Uint8Array>;
}

export type ByteRange = [start: number, end: number];

/** Region in pixels of the reduced-resolution image (origin at its top-left). */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecodePlan {
  reduction: number;
  /** Byte ranges (absolute, sorted, non-overlapping) the codestream is built from. */
  ranges: ByteRange[];
  /** Build the codestream; `read` must return already-fetched bytes. */
  build(read: (start: number, end: number) => Uint8Array): Uint8Array;
  /** Region to decode within the synthesized image at `reduction`. */
  region: Region;
  /** Samples per component the decoder works on (drives its memory use). */
  pixels: number;
}

interface TilePart {
  tile: number;
  partIndex: number;
  /** Absolute offset of SOT. */
  offset: number;
  length: number;
}

interface PacketIndex {
  /** Absolute byte offsets / lengths, in codestream order. */
  offsets: Float64Array;
  lengths: Uint32Array;
  /** seq[c][r][p * layers + l] = position of that packet in codestream order. */
  seq: Int32Array[][];
}

const INITIAL_READ = 64 * 1024;
/** Extra resolution-domain samples kept around a region for wavelet support. */
const PRECINCT_MARGIN = 16;

/** Read `[start, start+n)`, growing n until `parse` stops asking for more data. */
async function readUntilParsed<T>(
  src: ByteSource,
  start: number,
  limit: number,
  parse: (bytes: Uint8Array) => T,
  initial = INITIAL_READ,
): Promise<T> {
  let n = Math.min(initial, limit - start);
  for (;;) {
    const bytes = await src.read(start, start + n);
    try {
      return parse(bytes);
    } catch (e) {
      if (!(e instanceof NeedMoreData) || start + n >= limit) throw e;
      n = Math.min(Math.max(n * 2, e.needed + 4096), limit - start);
    }
  }
}

function u16(out: Uint8Array, at: number, v: number) {
  out[at] = v >> 8;
  out[at + 1] = v & 0xff;
}
function u32(out: Uint8Array, at: number, v: number) {
  new DataView(out.buffer, out.byteOffset).setUint32(at, v);
}

/** Concatenate chunks into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Merge sorted ranges whose gap is at most `gap` bytes. */
export function coalesce(ranges: ByteRange[], gap = 0): ByteRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: ByteRange[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export class Jp2Image {
  readonly mode: "tiles" | "precincts";
  /** Resolution levels that can be dropped (minimum over components). */
  readonly levels: number;

  private constructor(
    readonly layout: FileLayout,
    readonly header: MainHeader,
    /** SOC + main header bytes. */
    readonly headerBytes: Uint8Array,
    readonly tileParts: TilePart[],
    /** True when each tile's part k carries exactly resolution k. */
    readonly partsByResolution: boolean,
    private readonly tilePartHeaders: TilePartHeader[] | null,
    private readonly packets: PacketIndex | null,
    readonly fileSize: number,
  ) {
    this.mode = packets ? "precincts" : "tiles";
    this.levels = Math.min(...header.components.map((c) => c.levels));
  }

  get width(): number {
    return this.header.siz.xsiz - this.header.siz.xosiz;
  }
  get height(): number {
    return this.header.siz.ysiz - this.header.siz.yosiz;
  }

  /** Size of the image after dropping `d` resolution levels. */
  reducedSize(d: number): { width: number; height: number } {
    const s = this.header.siz;
    const k = 2 ** d;
    return {
      width: ceilDiv(s.xsiz, k) - ceilDiv(s.xosiz, k),
      height: ceilDiv(s.ysiz, k) - ceilDiv(s.yosiz, k),
    };
  }

  /** Bytes read to open the image (header + index), for stats. */
  get indexBytes(): number {
    const last = this.tilePartHeaders?.at(-1);
    return this.layout.codestreamOffset + (last ? last.dataOffset : this.header.end);
  }

  static async open(src: ByteSource): Promise<Jp2Image> {
    const fileSize = await src.size();
    const layout = await readUntilParsed(src, 0, fileSize, parseFileLayout);
    const cs = layout.codestreamOffset;
    const csEnd = Math.min(fileSize, cs + layout.codestreamLength);
    // Usually the main header fits in what the first read already fetched.
    const header = await readUntilParsed(src, cs, csEnd, parseMainHeader, Math.max(4096, INITIAL_READ - cs));
    if (header.unsupported.length) {
      throw new Error(`unsupported codestream features: ${header.unsupported.join(", ")}`);
    }
    const headerBytes = (await src.read(cs, cs + header.end)).slice();

    const numTiles = header.siz.numXTiles * header.siz.numYTiles;
    const tileParts: TilePart[] = [];
    let tilePartHeaders: TilePartHeader[] | null = null;

    const counts = new Map<number, number>();
    if (header.tlm) {
      let at = cs + header.end;
      for (const { tile, length } of header.tlm) {
        const partIndex = counts.get(tile) ?? 0;
        counts.set(tile, partIndex + 1);
        tileParts.push({ tile, partIndex, offset: at, length });
        at += length;
      }
    }

    // Single-tile files: read every tile-part header (for PLT). Multi-tile
    // files without TLM: walk SOT markers (one small read per tile-part).
    if (numTiles === 1 || !header.tlm) {
      tilePartHeaders = [];
      tileParts.length = 0;
      let at = header.end;
      while (cs + at + 2 <= csEnd) {
        const peek = await src.read(cs + at, cs + at + 2);
        if (((peek[0] << 8) | peek[1]) === Marker.EOC) break;
        const tph = await readUntilParsed(
          src,
          cs + at,
          csEnd,
          (b) => parseTilePartHeader(b, at, at),
          numTiles === 1 ? INITIAL_READ : 4096,
        );
        const length = tph.length || csEnd - cs - at;
        tilePartHeaders.push(tph);
        tileParts.push({ tile: tph.tile, partIndex: tph.partIndex, offset: cs + at, length });
        at += length;
      }
    }

    const maxLevels = Math.max(...header.components.map((c) => c.levels));
    const perTile = new Map<number, number>();
    for (const tp of tileParts) perTile.set(tp.tile, (perTile.get(tp.tile) ?? 0) + 1);
    const partsByResolution =
      (header.cod.progression === "RPCL" || header.cod.progression === "RLCP") &&
      header.components.every((c) => c.levels === maxLevels) &&
      perTile.size === numTiles &&
      [...perTile.values()].every((n) => n === maxLevels + 1);

    let packets: PacketIndex | null = null;
    if (numTiles === 1 && tilePartHeaders?.every((t) => t.packetLengths)) {
      packets = Jp2Image.buildPacketIndex(header, tilePartHeaders, cs);
    }
    return new Jp2Image(layout, header, headerBytes, tileParts, partsByResolution, tilePartHeaders, packets, fileSize);
  }

  private static buildPacketIndex(h: MainHeader, tphs: TilePartHeader[], cs: number): PacketIndex | null {
    if (tphs.some((t) => t.segments.some((s) => s.marker === Marker.PPT || s.marker === Marker.POC || s.marker === Marker.COD || s.marker === Marker.COC))) {
      return null;
    }
    const tile = tileRect(h, 0);
    const layers = h.cod.layers;
    const seq = h.components.map((coding, c) =>
      Array.from({ length: coding.levels + 1 }, (_, r) => {
        const res = resolution(h, tile, c, r);
        return new Int32Array(res.pw * res.ph * layers);
      }),
    );
    let n = 0;
    forEachPacket(h, tile, (r, c, p, l) => {
      seq[c][r][p * layers + l] = n++;
    });
    const total = tphs.reduce((sum, t) => sum + t.packetLengths!.length, 0);
    if (total !== n) {
      console.warn(`PLT lists ${total} packets but geometry predicts ${n}; using tile access`);
      return null;
    }
    const offsets = new Float64Array(total);
    const lengths = new Uint32Array(total);
    let k = 0;
    for (const t of tphs) {
      let at = cs + t.dataOffset;
      for (const len of t.packetLengths!) {
        offsets[k] = at;
        lengths[k++] = len;
        at += len;
      }
    }
    return { offsets, lengths, seq };
  }

  /** Plan decoding `region` (reduced-image pixels) after dropping `d` levels. */
  plan(d: number, region: Region): DecodePlan {
    if (d > this.levels) throw new Error(`reduction ${d} exceeds ${this.levels} levels`);
    return this.packets ? this.planPrecincts(d, region) : this.planTiles(d, region);
  }

  /**
   * Multi-tile access: crop the image to the tiles the region touches and
   * renumber them. When tile-parts are split by resolution and the tile size
   * is divisible by 2^d, also drop the d unused levels so the decoder works
   * at the reduced size; otherwise let the decoder discard them.
   */
  private planTiles(d: number, region: Region): DecodePlan {
    const h = this.header;
    const s = h.siz;
    const k = 2 ** d;
    // Region in reduced canvas coordinates.
    const ox = ceilDiv(s.xosiz, k);
    const oy = ceilDiv(s.yosiz, k);
    const want: Rect = { x0: ox + region.x, y0: oy + region.y, x1: ox + region.x + region.w, y1: oy + region.y + region.h };
    let i0 = Infinity, j0 = Infinity, i1 = -1, j1 = -1;
    for (let t = 0; t < s.numXTiles * s.numYTiles; t++) {
      const r = tileRect(h, t);
      const rr = { x0: ceilDiv(r.x0, k), y0: ceilDiv(r.y0, k), x1: ceilDiv(r.x1, k), y1: ceilDiv(r.y1, k) };
      if (!intersects(rr, want)) continue;
      const i = t % s.numXTiles;
      const j = Math.floor(t / s.numXTiles);
      i0 = Math.min(i0, i);
      j0 = Math.min(j0, j);
      i1 = Math.max(i1, i + 1);
      j1 = Math.max(j1, j + 1);
    }
    if (i1 < 0) throw new Error("region does not intersect the image");
    const keepRes = this.levels - d;
    const parts = this.tileParts.filter((tp) => {
      const i = tp.tile % s.numXTiles;
      const j = Math.floor(tp.tile / s.numXTiles);
      return i >= i0 && i < i1 && j >= j0 && j < j1 && (!this.partsByResolution || tp.partIndex <= keepRes);
    });
    const crop: SizFields = {
      xsiz: Math.min(s.xsiz, s.xtosiz + i1 * s.xtsiz),
      ysiz: Math.min(s.ysiz, s.ytosiz + j1 * s.ytsiz),
      xosiz: Math.max(s.xosiz, s.xtosiz + i0 * s.xtsiz),
      yosiz: Math.max(s.yosiz, s.ytosiz + j0 * s.ytsiz),
      xtsiz: s.xtsiz,
      ytsiz: s.ytsiz,
      xtosiz: s.xtosiz + i0 * s.xtsiz,
      ytosiz: s.ytosiz + j0 * s.ytsiz,
    };
    const drop = d > 0 && this.partsByResolution && s.xtsiz % k === 0 && s.ytsiz % k === 0 ? d : 0;
    const siz: SizFields = drop
      ? {
          xsiz: ceilDiv(crop.xsiz, k),
          ysiz: ceilDiv(crop.ysiz, k),
          xosiz: ceilDiv(crop.xosiz, k),
          yosiz: ceilDiv(crop.yosiz, k),
          xtsiz: s.xtsiz / k,
          ytsiz: s.ytsiz / k,
          xtosiz: ceilDiv(crop.xtosiz, k),
          ytosiz: ceilDiv(crop.ytosiz, k),
        }
      : crop;
    const nx = i1 - i0;
    const partCount = this.partsByResolution ? keepRes + 1 : 0;

    const build = (read: (start: number, end: number) => Uint8Array): Uint8Array => {
      const chunks: Uint8Array[] = [rewriteMainHeader(h, this.headerBytes, siz, drop)];
      for (const tp of parts) {
        const bytes = read(tp.offset, tp.offset + tp.length).slice();
        const i = tp.tile % s.numXTiles;
        const j = Math.floor(tp.tile / s.numXTiles);
        u16(bytes, 4, (j - j0) * nx + (i - i0));
        bytes[11] = partCount || bytes[11];
        chunks.push(bytes);
      }
      chunks.push(new Uint8Array([0xff, 0xd9]));
      return concat(chunks);
    };
    const reduction = d - drop;
    const kk = 2 ** reduction;
    return {
      reduction,
      ranges: coalesce(parts.map((p) => [p.offset, p.offset + p.length])),
      build,
      region: { x: want.x0 - ceilDiv(siz.xosiz, kk), y: want.y0 - ceilDiv(siz.yosiz, kk), w: region.w, h: region.h },
      pixels: (siz.xsiz - siz.xosiz) * (siz.ysiz - siz.yosiz),
    };
  }

  /**
   * Untiled access. The decoder is given a virtual tile: a codestream whose
   * reference grid is the reduced canvas cropped to a window around the
   * region, with the d unused levels dropped. The window is aligned to every
   * kept resolution's precinct grid, so all precincts and code-blocks inside
   * it are unchanged and the original packets can be reused as-is, and it
   * keeps a margin so boundary extension at its edges cannot reach the
   * region. Packets of precincts the region doesn't need become empty packets.
   */
  private planPrecincts(d: number, region: Region): DecodePlan {
    const h = this.header;
    const s = h.siz;
    const pk = this.packets!;
    const layers = h.cod.layers;
    const k = 2 ** d;
    // Everything below is in reduced canvas coordinates.
    const ox = ceilDiv(s.xosiz, k);
    const oy = ceilDiv(s.yosiz, k);
    const want: Rect = { x0: ox + region.x, y0: oy + region.y, x1: ox + region.x + region.w, y1: oy + region.y + region.h };
    const fullTile = tileRect(h, 0);
    const tile: Rect = { x0: ceilDiv(fullTile.x0, k), y0: ceilDiv(fullTile.y0, k), x1: ceilDiv(fullTile.x1, k), y1: ceilDiv(fullTile.y1, k) };

    const kept = h.components.map((coding) => coding.levels - d);
    let ax = 1;
    let ay = 1;
    h.components.forEach((coding, c) => {
      for (let r = 0; r <= kept[c]; r++) {
        const { ppx, ppy } = coding.precincts[r];
        ax = Math.max(ax, s.components[c].xrsiz * 2 ** (kept[c] - r + ppx));
        ay = Math.max(ay, s.components[c].yrsiz * 2 ** (kept[c] - r + ppy));
      }
    });
    // Wavelet boundary effects reach about 4 * 2^(levels+1) samples inward;
    // the window is the aligned hull of the region grown by that much.
    const support = 2 ** (Math.max(...kept) + 3);
    const win: Rect = {
      x0: Math.max(tile.x0, Math.floor((want.x0 - support) / ax) * ax),
      y0: Math.max(tile.y0, Math.floor((want.y0 - support) / ay) * ay),
      x1: Math.min(tile.x1, Math.ceil((want.x1 + support) / ax) * ax),
      y1: Math.min(tile.y1, Math.ceil((want.y1 + support) / ay) * ay),
    };
    const siz: SizFields = {
      xsiz: win.x1,
      ysiz: win.y1,
      xosiz: win.x0,
      yosiz: win.y0,
      xtsiz: win.x1 - win.x0,
      ytsiz: win.y1 - win.y0,
      xtosiz: win.x0,
      ytosiz: win.y0,
    };
    const winHeader = rewrittenHeader(h, siz, d);

    // Per (component, resolution): needed precincts (original indices) and
    // the map from window precinct index to original precinct index.
    // Resolution coordinates are identical in both codestreams.
    const needed: Set<number>[][] = [];
    const remap: ((p: number) => number)[][] = [];
    h.components.forEach((_, c) => {
      const comp = s.components[c];
      needed.push([]);
      remap.push([]);
      for (let r = 0; r <= kept[c]; r++) {
        const res = resolution(h, fullTile, c, r);
        const wres = resolution(winHeader, win, c, r);
        const di = Math.floor(wres.rect.x0 / 2 ** res.ppx) - Math.floor(res.rect.x0 / 2 ** res.ppx);
        const dj = Math.floor(wres.rect.y0 / 2 ** res.ppy) - Math.floor(res.rect.y0 / 2 ** res.ppy);
        remap[c].push((p) => (p % wres.pw) + di + (Math.floor(p / wres.pw) + dj) * res.pw);
        const scale = 2 ** (kept[c] - r);
        const area: Rect = {
          x0: Math.floor(Math.ceil(want.x0 / comp.xrsiz) / scale) - PRECINCT_MARGIN,
          y0: Math.floor(Math.ceil(want.y0 / comp.yrsiz) / scale) - PRECINCT_MARGIN,
          x1: Math.ceil(Math.ceil(want.x1 / comp.xrsiz) / scale) + PRECINCT_MARGIN,
          y1: Math.ceil(Math.ceil(want.y1 / comp.yrsiz) / scale) + PRECINCT_MARGIN,
        };
        const set = new Set<number>();
        for (let p = 0; p < res.pw * res.ph; p++) if (intersects(precinctRect(res, p), area)) set.add(p);
        needed[c].push(set);
      }
    });

    // The window's packet sequence: original packet index, or -1 for empty.
    const entries: number[] = [];
    forEachPacket(winHeader, win, (r, c, p, l) => {
      const orig = remap[c][r](p);
      entries.push(needed[c][r].has(orig) ? pk.seq[c][r][orig * layers + l] : -1);
    });

    const ranges: ByteRange[] = [];
    for (const e of entries) {
      if (e >= 0 && pk.lengths[e] > 0) ranges.push([pk.offsets[e], pk.offsets[e] + pk.lengths[e]]);
    }
    const sop = h.cod.sop;
    const eph = h.cod.eph;
    const tph = this.tilePartHeaders![0];

    const build = (read: (start: number, end: number) => Uint8Array): Uint8Array => {
      const chunks: Uint8Array[] = [rewriteMainHeader(h, this.headerBytes, siz, d)];
      const sot = new Uint8Array(12);
      chunks.push(sot);
      let size = 12;
      for (const seg of tph.segments) {
        if (seg.marker === Marker.PLT) continue;
        const start = this.layout.codestreamOffset + seg.offset;
        const b = read(start, start + seg.size);
        chunks.push(b);
        size += b.length;
      }
      chunks.push(new Uint8Array([0xff, 0x93]));
      size += 2;
      entries.forEach((e, i) => {
        let b: Uint8Array;
        if (e >= 0) {
          b = read(pk.offsets[e], pk.offsets[e] + pk.lengths[e]);
        } else {
          b = new Uint8Array((sop ? 6 : 0) + 1 + (eph ? 2 : 0));
          if (sop) b.set([0xff, 0x91, 0x00, 0x04, (i >> 8) & 0xff, i & 0xff]);
          if (eph) b.set([0xff, 0x92], b.length - 2);
        }
        chunks.push(b);
        size += b.length;
      });
      u16(sot, 0, Marker.SOT);
      u16(sot, 2, 10);
      u16(sot, 4, 0);
      u32(sot, 6, size);
      sot[10] = 0;
      sot[11] = 1;
      chunks.push(new Uint8Array([0xff, 0xd9]));
      return concat(chunks);
    };
    return {
      reduction: 0,
      ranges: coalesce(ranges, 0),
      build,
      region: { x: want.x0 - win.x0, y: want.y0 - win.y0, w: region.w, h: region.h },
      pixels: (win.x1 - win.x0) * (win.y1 - win.y0),
    };
  }
}
