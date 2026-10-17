/**
 * JP2 / JPH file-format box parsing (ISO/IEC 15444-1 Annex I, 15444-15).
 *
 * We only need enough to find the contiguous codestream (`jp2c`) and to keep
 * the header box (`jp2h`) for colour information.
 */

export interface Box {
  type: string;
  /** Absolute offset of the box header. */
  offset: number;
  /** Offset of the box contents. */
  contentOffset: number;
  /** Total length including header; `Infinity` when the box runs to end of file. */
  length: number;
}

export interface FileLayout {
  kind: "jp2" | "j2c";
  boxes: Box[];
  /** Absolute offset of the codestream's SOC marker. */
  codestreamOffset: number;
  /** Codestream length in bytes, or `Infinity` if it runs to end of file. */
  codestreamLength: number;
}

const JP2_SIGNATURE = [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

export class NeedMoreData extends Error {
  constructor(public readonly needed: number) {
    super(`need at least ${needed} bytes`);
  }
}

function boxType(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

/**
 * Locate the codestream in `head`, the first bytes of a file.
 * Throws {@link NeedMoreData} when `head` ends before the `jp2c` box header.
 */
export function parseFileLayout(head: Uint8Array): FileLayout {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0x4f) {
    return { kind: "j2c", boxes: [], codestreamOffset: 0, codestreamLength: Infinity };
  }
  if (head.length < JP2_SIGNATURE.length) throw new NeedMoreData(JP2_SIGNATURE.length);
  if (!JP2_SIGNATURE.every((v, i) => head[i] === v)) {
    throw new Error("not a JPEG 2000 file (no JP2 signature or SOC marker)");
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const boxes: Box[] = [];
  let at = 0;
  for (;;) {
    if (at + 8 > head.length) throw new NeedMoreData(at + 16);
    const lbox = view.getUint32(at);
    const type = boxType(head, at + 4);
    let header = 8;
    let length: number;
    if (lbox === 1) {
      if (at + 16 > head.length) throw new NeedMoreData(at + 16);
      length = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (lbox === 0) {
      length = Infinity;
    } else {
      length = lbox;
    }
    const box = { type, offset: at, contentOffset: at + header, length };
    boxes.push(box);
    if (type === "jp2c") {
      return {
        kind: "jp2",
        boxes,
        codestreamOffset: box.contentOffset,
        codestreamLength: length === Infinity ? Infinity : length - header,
      };
    }
    if (length === Infinity) throw new Error(`box ${type} runs to end of file before jp2c`);
    at += length;
  }
}
