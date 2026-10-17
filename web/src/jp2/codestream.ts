/**
 * Codestream marker parsing (ISO/IEC 15444-1 Annex A): the main header and
 * tile-part headers. All offsets here are relative to the SOC marker.
 */

import { NeedMoreData } from "./boxes";

export const Marker = {
  SOC: 0xff4f,
  CAP: 0xff50,
  SIZ: 0xff51,
  COD: 0xff52,
  COC: 0xff53,
  TLM: 0xff55,
  PLM: 0xff57,
  PLT: 0xff58,
  QCD: 0xff5c,
  QCC: 0xff5d,
  RGN: 0xff5e,
  POC: 0xff5f,
  PPM: 0xff60,
  PPT: 0xff61,
  CRG: 0xff63,
  COM: 0xff64,
  SOT: 0xff90,
  SOP: 0xff91,
  EPH: 0xff92,
  SOD: 0xff93,
  EOC: 0xffd9,
} as const;

export type Progression = "LRCP" | "RLCP" | "RPCL" | "PCRL" | "CPRL";
const PROGRESSIONS: Progression[] = ["LRCP", "RLCP", "RPCL", "PCRL", "CPRL"];

export interface ComponentSiz {
  precision: number;
  signed: boolean;
  xrsiz: number;
  yrsiz: number;
}

export interface Siz {
  rsiz: number;
  xsiz: number;
  ysiz: number;
  xosiz: number;
  yosiz: number;
  xtsiz: number;
  ytsiz: number;
  xtosiz: number;
  ytosiz: number;
  components: ComponentSiz[];
  numXTiles: number;
  numYTiles: number;
}

/** Per-component coding parameters (from COD, overridden by COC). */
export interface ComponentCoding {
  levels: number;
  cblkW: number;
  cblkH: number;
  cblkStyle: number;
  /** 0 = irreversible 9/7, 1 = reversible 5/3. */
  transform: number;
  /** log2 precinct width/height per resolution, index 0 = lowest resolution. */
  precincts: { ppx: number; ppy: number }[];
}

export interface Cod {
  sop: boolean;
  eph: boolean;
  progression: Progression;
  layers: number;
  mct: number;
  component: ComponentCoding;
}

export interface Segment {
  marker: number;
  /** Offset of the marker (0xFF..) relative to SOC. */
  offset: number;
  /** Total bytes including marker and length field. */
  size: number;
}

export interface TlmEntry {
  tile: number;
  length: number;
}

export interface MainHeader {
  siz: Siz;
  cod: Cod;
  /** Per-component coding, with COC overrides applied. */
  components: ComponentCoding[];
  /** Tile-part lengths in codestream order, if TLM markers are present. */
  tlm: TlmEntry[] | null;
  segments: Segment[];
  /** Offset of the first SOT marker (= length of SOC + main header). */
  end: number;
  unsupported: string[];
}

export interface TilePartHeader {
  /** Offset of SOT relative to SOC. */
  offset: number;
  tile: number;
  /** Psot: length of the whole tile-part, 0 = until EOC. */
  length: number;
  partIndex: number;
  /** TNsot; 0 means unknown. */
  partCount: number;
  segments: Segment[];
  /** Packet lengths from PLT markers, in order, or null if no PLT. */
  packetLengths: number[] | null;
  /** Offset of the first byte after SOD (packet data start), relative to SOC. */
  dataOffset: number;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(end: number): void {
    if (end > this.bytes.length) throw new NeedMoreData(end);
  }
  u8(at: number): number {
    this.need(at + 1);
    return this.bytes[at];
  }
  u16(at: number): number {
    this.need(at + 2);
    return this.view.getUint16(at);
  }
  u32(at: number): number {
    this.need(at + 4);
    return this.view.getUint32(at);
  }
}

function parseSiz(r: Reader, at: number, len: number): Siz {
  const c = r.u16(at + 36);
  if (38 + 3 * c !== len) throw new Error("malformed SIZ");
  const components: ComponentSiz[] = [];
  for (let i = 0; i < c; i++) {
    const ssiz = r.u8(at + 38 + 3 * i);
    components.push({
      precision: (ssiz & 0x7f) + 1,
      signed: (ssiz & 0x80) !== 0,
      xrsiz: r.u8(at + 39 + 3 * i),
      yrsiz: r.u8(at + 40 + 3 * i),
    });
  }
  const siz = {
    rsiz: r.u16(at + 2),
    xsiz: r.u32(at + 4),
    ysiz: r.u32(at + 8),
    xosiz: r.u32(at + 12),
    yosiz: r.u32(at + 16),
    xtsiz: r.u32(at + 20),
    ytsiz: r.u32(at + 24),
    xtosiz: r.u32(at + 28),
    ytosiz: r.u32(at + 32),
    components,
  };
  return {
    ...siz,
    numXTiles: Math.ceil((siz.xsiz - siz.xtosiz) / siz.xtsiz),
    numYTiles: Math.ceil((siz.ysiz - siz.ytosiz) / siz.ytsiz),
  };
}

/** Parse SPcod/SPcoc starting at `at`; `precinctsDefined` from Scod/Scoc bit 0. */
function parseComponentCoding(r: Reader, at: number, end: number, precinctsDefined: boolean): ComponentCoding {
  const levels = r.u8(at);
  const precincts: { ppx: number; ppy: number }[] = [];
  for (let i = 0; i <= levels; i++) {
    if (precinctsDefined) {
      if (at + 5 + i >= end) throw new Error("missing precinct sizes");
      const b = r.u8(at + 5 + i);
      precincts.push({ ppx: b & 0x0f, ppy: b >> 4 });
    } else {
      precincts.push({ ppx: 15, ppy: 15 });
    }
  }
  return {
    levels,
    cblkW: 1 << (r.u8(at + 1) + 2),
    cblkH: 1 << (r.u8(at + 2) + 2),
    cblkStyle: r.u8(at + 3),
    transform: r.u8(at + 4),
    precincts,
  };
}

function parseCod(r: Reader, at: number, len: number): Cod {
  const scod = r.u8(at + 2);
  const prog = r.u8(at + 3);
  if (prog >= PROGRESSIONS.length) throw new Error(`unknown progression order ${prog}`);
  return {
    sop: (scod & 0x02) !== 0,
    eph: (scod & 0x04) !== 0,
    progression: PROGRESSIONS[prog],
    layers: r.u16(at + 4),
    mct: r.u8(at + 6),
    component: parseComponentCoding(r, at + 7, at + 2 + len, (scod & 0x01) !== 0),
  };
}

function parseTlm(r: Reader, at: number, len: number, out: TlmEntry[], nextImplicitTile: () => number): void {
  const stlm = r.u8(at + 5);
  const st = (stlm >> 4) & 0x03;
  const sp = (stlm >> 6) & 0x01;
  const end = at + 2 + len;
  for (let p = at + 6; p < end; ) {
    let tile: number;
    if (st === 0) tile = nextImplicitTile();
    else if (st === 1) tile = r.u8(p);
    else tile = r.u16(p);
    p += st;
    const length = sp ? r.u32(p) : r.u16(p);
    p += sp ? 4 : 2;
    out.push({ tile, length });
  }
}

/** Decode a PLT body's variable-length packet lengths (A.7.3). */
function parsePlt(r: Reader, at: number, end: number, out: number[]): void {
  let v = 0;
  for (let p = at; p < end; p++) {
    const b = r.u8(p);
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      out.push(v);
      v = 0;
    }
  }
  if (v !== 0) throw new Error("PLT ends mid-value");
}

/** Parse SOC + main header from `bytes` (which starts at SOC). */
export function parseMainHeader(bytes: Uint8Array): MainHeader {
  const r = new Reader(bytes);
  if (r.u16(0) !== Marker.SOC) throw new Error("codestream does not start with SOC");
  const segments: Segment[] = [];
  const unsupported: string[] = [];
  let siz: Siz | null = null;
  let cod: Cod | null = null;
  const coc = new Map<number, { at: number; len: number }>();
  const tlmMarkers: { z: number; at: number; len: number }[] = [];
  let at = 2;
  for (;;) {
    const marker = r.u16(at);
    if (marker === Marker.SOT) break;
    if ((marker & 0xff00) !== 0xff00) throw new Error(`bad marker 0x${marker.toString(16)} at ${at}`);
    const len = r.u16(at + 2);
    r.need(at + 2 + len);
    segments.push({ marker, offset: at, size: 2 + len });
    switch (marker) {
      case Marker.SIZ:
        siz = parseSiz(r, at + 2, len);
        break;
      case Marker.COD:
        cod = parseCod(r, at + 2, len);
        break;
      case Marker.COC: {
        const wide = (siz?.components.length ?? 0) >= 257;
        const comp = wide ? r.u16(at + 4) : r.u8(at + 4);
        coc.set(comp, { at: at + 4 + (wide ? 2 : 1), len });
        break;
      }
      case Marker.TLM:
        tlmMarkers.push({ z: r.u8(at + 4), at, len });
        break;
      case Marker.POC:
        unsupported.push("POC (progression order change)");
        break;
      case Marker.PPM:
        unsupported.push("PPM (packed packet headers)");
        break;
    }
    at += 2 + len;
  }
  if (!siz) throw new Error("missing SIZ");
  if (!cod) throw new Error("missing COD");
  const components = siz.components.map((_, i) => {
    const o = coc.get(i);
    if (!o) return cod.component;
    const scoc = r.u8(o.at);
    return parseComponentCoding(r, o.at + 1, at, (scoc & 0x01) !== 0);
  });

  let tlm: TlmEntry[] | null = null;
  if (tlmMarkers.length) {
    tlm = [];
    let implicit = 0;
    for (const t of tlmMarkers.sort((a, b) => a.z - b.z)) {
      parseTlm(r, t.at, t.len, tlm, () => implicit++);
    }
  }
  return { siz, cod, components, tlm, segments, end: at, unsupported };
}

/**
 * Parse a tile-part header. `bytes` holds codestream data starting at
 * codestream offset `base`; `sotOffset` is also relative to SOC.
 */
export function parseTilePartHeader(bytes: Uint8Array, base: number, sotOffset: number): TilePartHeader {
  const r = new Reader(bytes);
  const at0 = sotOffset - base;
  if (at0 < 0) throw new Error("tile-part header starts before buffer");
  if (r.u16(at0) !== Marker.SOT) throw new Error(`expected SOT at ${sotOffset}`);
  const header: TilePartHeader = {
    offset: sotOffset,
    tile: r.u16(at0 + 4),
    length: r.u32(at0 + 6),
    partIndex: r.u8(at0 + 10),
    partCount: r.u8(at0 + 11),
    segments: [],
    packetLengths: null,
    dataOffset: 0,
  };
  let at = at0 + 12;
  for (;;) {
    const marker = r.u16(at);
    if (marker === Marker.SOD) {
      header.dataOffset = base + at + 2;
      return header;
    }
    const len = r.u16(at + 2);
    r.need(at + 2 + len);
    header.segments.push({ marker, offset: base + at, size: 2 + len });
    if (marker === Marker.PLT) {
      header.packetLengths ??= [];
      parsePlt(r, at + 5, at + 2 + len, header.packetLengths);
    }
    at += 2 + len;
  }
}
