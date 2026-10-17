// Region decode timing + check vs kdu_expand -region.
// Usage: node wasm/test/region.mjs <file> <reduction> <x> <y> <w> <h>   (coords in reduced pixels)
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, decode, inspect } from "../../web/src/wasm-pkg/j2k.js";

initSync({ module: readFileSync(new URL("../../web/src/wasm-pkg/j2k_bg.wasm", import.meta.url)) });
const [file, ...nums] = process.argv.slice(2);
const [r, x, y, w, h] = nums.map(Number);
const bytes = readFileSync(file);
const info = inspect(bytes);
const t0 = performance.now();
const img = decode(bytes, r, x, y, w, h);
const ms = performance.now() - t0;
const rgba = img.takeData();

const s = 2 ** r, W = info.width, H = info.height;
const region = `{${(y * s) / H},${(x * s) / W}},{${(h * s) / H},${(w * s) / W}}`;
const ppm = join(mkdtempSync(join(tmpdir(), "j2k-")), "ref.ppm");
execFileSync("kdu_expand", ["-quiet", "-i", file, "-o", ppm, "-reduce", String(r), "-region", region]);
const ref = readFileSync(ppm);
const m = ref.subarray(0, 64).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
const rgb = ref.subarray(m[0].length);
let max = 0;
for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(rgba[p * 4 + c] - rgb[p * 3 + c]));
console.log(`${file} r=${r} ${w}x${h}@${x},${y}: ${ms.toFixed(1)} ms, kakadu ${m[1]}x${m[2]}, max|diff|=${max}`);
