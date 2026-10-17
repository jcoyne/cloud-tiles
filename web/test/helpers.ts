import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSync, decode } from "../src/wasm-pkg/j2k.js";
import { HttpRangeSource } from "../src/net/range-source";

export const TESTDATA = resolve(__dirname, "../../testdata");
export const fixture = (name: string) => resolve(TESTDATA, name);
export const hasFixture = (name: string) => existsSync(fixture(name));

let wasmReady = false;
export function wasm() {
  if (!wasmReady) {
    initSync({ module: readFileSync(resolve(__dirname, "../src/wasm-pkg/j2k_bg.wasm")) });
    wasmReady = true;
  }
  return { decode };
}

/** A fetch stand-in that serves a local file with single-range semantics. */
export function fileFetch(path: string): typeof fetch {
  const file = readFileSync(path);
  return (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response(file, { status: 200 });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), file.length - 1);
    return new Response(file.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${file.length}` },
    });
  }) as typeof fetch;
}

export function sourceFor(name: string) {
  return new HttpRangeSource(`file://${name}`, { fetch: fileFetch(fixture(name)) });
}

export function decodeRGBA(bytes: Uint8Array, reduction: number, x = 0, y = 0, w = 0, h = 0) {
  const img = wasm().decode(bytes, reduction, x, y, w, h);
  const data = img.takeData();
  return { width: img.width, height: img.height, data };
}

export function maxDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
