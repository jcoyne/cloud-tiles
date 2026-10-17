/**
 * Main-header rewriting for synthesized codestreams.
 *
 * Besides moving the image/tile origin (SIZ), this can *drop resolution
 * levels*: decoding a codestream after discarding d levels gives exactly the
 * same samples as decoding a codestream that has NL-d levels and the reduced
 * canvas as its reference grid, because
 * - ceil(ceil(x / 2^d) / 2^n) = ceil(x / 2^(d+n)), so resolution, sub-band,
 *   precinct and code-block partitions of the kept resolutions are unchanged
 *   (B-14, B-15), and the packets can be reused byte-for-byte;
 * - quantization step sizes depend on sub-band orientation, not level
 *   (E-3), so QCD/QCC just keep the first 1 + 3(NL-d) entries, and derived
 *   quantization (E-5) gives the same exponents with the same epsilon_0.
 *
 * The point is memory: j2k sizes its coefficient storage from the
 * full-resolution tile even when asked to skip levels.
 */

import { Marker, type ComponentCoding, type MainHeader, type Siz } from "./codestream";

export type SizFields = Pick<Siz, "xsiz" | "ysiz" | "xosiz" | "yosiz" | "xtsiz" | "ytsiz" | "xtosiz" | "ytosiz">;

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
function put16(b: Uint8Array, at: number, v: number) {
  b[at] = v >> 8;
  b[at + 1] = v & 0xff;
}
function put32(b: Uint8Array, at: number, v: number) {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v);
}

/** Parsed-header model of the rewritten codestream, for geometry. */
export function rewrittenHeader(h: MainHeader, siz: SizFields, drop: number): MainHeader {
  const dropLevels = (c: ComponentCoding): ComponentCoding => ({
    ...c,
    levels: c.levels - drop,
    precincts: c.precincts.slice(0, c.levels - drop + 1),
  });
  return {
    ...h,
    siz: {
      ...h.siz,
      ...siz,
      numXTiles: Math.ceil((siz.xsiz - siz.xtosiz) / siz.xtsiz),
      numYTiles: Math.ceil((siz.ysiz - siz.ytosiz) / siz.ytsiz),
    },
    cod: { ...h.cod, component: dropLevels(h.cod.component) },
    components: h.components.map(dropLevels),
    tlm: null,
  };
}

/** Number of quantization entries kept for a component with `levels` levels. */
function truncateQuant(seg: Uint8Array, styleAt: number, levels: number): Uint8Array {
  const style = seg[styleAt] & 0x1f;
  if (style === 1) return seg; // scalar derived: a single entry
  const entry = style === 0 ? 1 : 2;
  const end = styleAt + 1 + entry * (1 + 3 * levels);
  if (end > seg.length) throw new Error("quantization marker shorter than expected");
  const out = seg.slice(0, end);
  put16(out, 2, end - 2);
  return out;
}

/** COD/COC: SPcod starts at `at` (levels byte); drop levels and precinct sizes. */
function truncateCoding(seg: Uint8Array, at: number, precinctsDefined: boolean, drop: number): Uint8Array {
  const levels = seg[at] - drop;
  if (levels < 0) throw new Error("cannot drop more levels than the component has");
  const end = at + 5 + (precinctsDefined ? levels + 1 : 0);
  const out = seg.slice(0, end);
  out[at] = levels;
  put16(out, 2, end - 2);
  return out;
}

/**
 * SOC + main header with SIZ replaced and `drop` resolution levels removed.
 * TLM and PLM are omitted because they would describe the original file.
 */
export function rewriteMainHeader(h: MainHeader, headerBytes: Uint8Array, siz: SizFields, drop = 0): Uint8Array {
  const wideComponents = h.siz.components.length >= 257;
  const parts: Uint8Array[] = [headerBytes.subarray(0, 2)];
  for (const s of h.segments) {
    if (s.marker === Marker.TLM || s.marker === Marker.PLM) continue;
    let seg = headerBytes.subarray(s.offset, s.offset + s.size);
    switch (s.marker) {
      case Marker.SIZ:
        seg = seg.slice();
        put32(seg, 6, siz.xsiz);
        put32(seg, 10, siz.ysiz);
        put32(seg, 14, siz.xosiz);
        put32(seg, 18, siz.yosiz);
        put32(seg, 22, siz.xtsiz);
        put32(seg, 26, siz.ytsiz);
        put32(seg, 30, siz.xtosiz);
        put32(seg, 34, siz.ytosiz);
        break;
      case Marker.COD:
        if (drop) seg = truncateCoding(seg, 9, (seg[4] & 1) !== 0, drop);
        break;
      case Marker.COC: {
        if (!drop) break;
        const sAt = wideComponents ? 6 : 5;
        seg = truncateCoding(seg, sAt + 1, (seg[sAt] & 1) !== 0, drop);
        break;
      }
      case Marker.QCD:
        if (drop) seg = truncateQuant(seg, 4, h.cod.component.levels - drop);
        break;
      case Marker.QCC: {
        if (!drop) break;
        const c = wideComponents ? u16(seg, 4) : seg[4];
        seg = truncateQuant(seg, wideComponents ? 6 : 5, h.components[c].levels - drop);
        break;
      }
    }
    parts.push(seg);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
