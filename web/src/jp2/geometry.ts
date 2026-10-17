/**
 * Canvas geometry (ISO/IEC 15444-1 Annex B): tiles, tile-components,
 * resolutions, precincts, and the packet sequence for each progression order.
 *
 * Coordinates can exceed 2^31, so this uses plain arithmetic, never bit shifts.
 */

import type { ComponentCoding, MainHeader, Progression } from "./codestream";

export interface Rect {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  /** Exclusive. */
  y1: number;
}

export const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const pow2 = (n: number): number => 2 ** n;

export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Tile rectangle on the reference grid (B-7..B-10). */
export function tileRect(h: MainHeader, tile: number): Rect {
  const s = h.siz;
  const p = tile % s.numXTiles;
  const q = Math.floor(tile / s.numXTiles);
  return {
    x0: Math.max(s.xtosiz + p * s.xtsiz, s.xosiz),
    y0: Math.max(s.ytosiz + q * s.ytsiz, s.yosiz),
    x1: Math.min(s.xtosiz + (p + 1) * s.xtsiz, s.xsiz),
    y1: Math.min(s.ytosiz + (q + 1) * s.ytsiz, s.ysiz),
  };
}

export interface Resolution {
  /** Resolution index r, 0 = lowest (LL only). */
  r: number;
  /** Bounds in this resolution's own coordinates (B-14). */
  rect: Rect;
  ppx: number;
  ppy: number;
  /** Number of precincts horizontally / vertically (B-16). */
  pw: number;
  ph: number;
}

/** Resolution r of component c within a tile, per B-14 and B-16. */
export function resolution(
  h: MainHeader,
  tile: Rect,
  c: number,
  r: number,
  coding: ComponentCoding = h.components[c],
): Resolution {
  const comp = h.siz.components[c];
  const tc: Rect = {
    x0: ceilDiv(tile.x0, comp.xrsiz),
    y0: ceilDiv(tile.y0, comp.yrsiz),
    x1: ceilDiv(tile.x1, comp.xrsiz),
    y1: ceilDiv(tile.y1, comp.yrsiz),
  };
  const scale = pow2(coding.levels - r);
  const rect: Rect = {
    x0: ceilDiv(tc.x0, scale),
    y0: ceilDiv(tc.y0, scale),
    x1: ceilDiv(tc.x1, scale),
    y1: ceilDiv(tc.y1, scale),
  };
  const { ppx, ppy } = coding.precincts[r];
  const pw = rect.x1 > rect.x0 ? ceilDiv(rect.x1, pow2(ppx)) - floorDiv(rect.x0, pow2(ppx)) : 0;
  const ph = rect.y1 > rect.y0 ? ceilDiv(rect.y1, pow2(ppy)) - floorDiv(rect.y0, pow2(ppy)) : 0;
  return { r, rect, ppx, ppy, pw, ph };
}

/** Bounds of precinct `p` of a resolution, in that resolution's coordinates. */
export function precinctRect(res: Resolution, p: number): Rect {
  const i = p % res.pw;
  const j = Math.floor(p / res.pw);
  const w = pow2(res.ppx);
  const hgt = pow2(res.ppy);
  const bx = floorDiv(res.rect.x0, w) * w;
  const by = floorDiv(res.rect.y0, hgt) * hgt;
  return {
    x0: Math.max(bx + i * w, res.rect.x0),
    y0: Math.max(by + j * hgt, res.rect.y0),
    x1: Math.min(bx + (i + 1) * w, res.rect.x1),
    y1: Math.min(by + (j + 1) * hgt, res.rect.y1),
  };
}

export interface PacketId {
  r: number;
  c: number;
  /** Precinct index within (component, resolution). */
  p: number;
  l: number;
}

/** All packets of one tile, in codestream order. */
export function packetOrder(h: MainHeader, tileIndex: number, progression: Progression = h.cod.progression): PacketId[] {
  const out: PacketId[] = [];
  forEachPacket(h, tileRect(h, tileIndex), (r, c, p, l) => out.push({ r, c, p, l }), progression);
  return out;
}

/**
 * Visit the packets of the tile covering `tile` in codestream order without
 * allocating per packet. The position-driven orders (RPCL, PCRL, CPRL) follow
 * B.12.1.3-5 including non-power-of-two offsets.
 */
export function forEachPacket(
  h: MainHeader,
  tile: Rect,
  visit: (r: number, c: number, p: number, l: number) => void,
  progression: Progression = h.cod.progression,
): void {
  const ncomp = h.siz.components.length;
  const layers = h.cod.layers;
  const res: Resolution[][] = [];
  for (let c = 0; c < ncomp; c++) {
    const list: Resolution[] = [];
    for (let r = 0; r <= h.components[c].levels; r++) list.push(resolution(h, tile, c, r));
    res.push(list);
  }
  const maxRes = Math.max(...res.map((l) => l.length));
  const precinctCount = (c: number, r: number) => res[c][r].pw * res[c][r].ph;

  switch (progression) {
    case "LRCP":
      for (let l = 0; l < layers; l++)
        for (let r = 0; r < maxRes; r++)
          for (let c = 0; c < ncomp; c++)
            if (r < res[c].length) for (let p = 0; p < precinctCount(c, r); p++) visit(r, c, p, l);
      return;
    case "RLCP":
      for (let r = 0; r < maxRes; r++)
        for (let l = 0; l < layers; l++)
          for (let c = 0; c < ncomp; c++)
            if (r < res[c].length) for (let p = 0; p < precinctCount(c, r); p++) visit(r, c, p, l);
      return;
  }

  // Position-driven orders. For each candidate grid position (x, y), a
  // component/resolution "fires" when (x, y) is the top-left of one of its
  // precincts (projected onto the reference grid).
  const precinctAt = (c: number, r: number, x: number, y: number): number => {
    const comp = h.siz.components[c];
    const rr = res[c][r];
    if (rr.pw === 0 || rr.ph === 0) return -1;
    const level = h.components[c].levels - r;
    const sx = comp.xrsiz * pow2(level);
    const sy = comp.yrsiz * pow2(level);
    const fireY = y % (comp.yrsiz * pow2(rr.ppy + level)) === 0 || (y === tile.y0 && (rr.rect.y0 * pow2(level)) % pow2(rr.ppy + level) !== 0);
    const fireX = x % (comp.xrsiz * pow2(rr.ppx + level)) === 0 || (x === tile.x0 && (rr.rect.x0 * pow2(level)) % pow2(rr.ppx + level) !== 0);
    if (!fireX || !fireY) return -1;
    const i = floorDiv(ceilDiv(x, sx), pow2(rr.ppx)) - floorDiv(rr.rect.x0, pow2(rr.ppx));
    const j = floorDiv(ceilDiv(y, sy), pow2(rr.ppy)) - floorDiv(rr.rect.y0, pow2(rr.ppy));
    return i + j * rr.pw;
  };
  const step = (cs: number[], axis: "x" | "y"): number => {
    let d = Infinity;
    for (const c of cs) {
      const comp = h.siz.components[c];
      for (const rr of res[c]) {
        const level = h.components[c].levels - rr.r;
        const v = (axis === "x" ? comp.xrsiz : comp.yrsiz) * pow2((axis === "x" ? rr.ppx : rr.ppy) + level);
        d = Math.min(d, v);
      }
    }
    return d;
  };
  const allComps = [...Array(ncomp).keys()];
  const positions = function* (cs: number[]): Generator<[number, number]> {
    const dx = step(cs, "x");
    const dy = step(cs, "y");
    for (let y = tile.y0; y < tile.y1; y += dy - (y % dy))
      for (let x = tile.x0; x < tile.x1; x += dx - (x % dx)) yield [x, y];
  };
  const emit = (c: number, r: number, x: number, y: number) => {
    if (r >= res[c].length) return;
    const p = precinctAt(c, r, x, y);
    if (p < 0) return;
    for (let l = 0; l < layers; l++) visit(r, c, p, l);
  };

  if (progression === "RPCL") {
    for (let r = 0; r < maxRes; r++)
      for (const [x, y] of positions(allComps)) for (let c = 0; c < ncomp; c++) emit(c, r, x, y);
  } else if (progression === "PCRL") {
    for (const [x, y] of positions(allComps))
      for (let c = 0; c < ncomp; c++) for (let r = 0; r < res[c].length; r++) emit(c, r, x, y);
  } else {
    for (let c = 0; c < ncomp; c++)
      for (const [x, y] of positions([c])) for (let r = 0; r < res[c].length; r++) emit(c, r, x, y);
  }
}
