// Decode a file with the WASM build and compare against kdu_expand output.
// Usage: node wasm/test/compare-kakadu.mjs <file.jp2> [reduction=3]
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, decode, inspect } from "../../web/src/wasm-pkg/j2k.js";

initSync({ module: readFileSync(new URL("../../web/src/wasm-pkg/j2k_bg.wasm", import.meta.url)) });

const [file, reductionArg = "3"] = process.argv.slice(2);
const reduction = Number(reductionArg);
const bytes = readFileSync(file);
const info = inspect(bytes);
console.log(`${file}: ${info.width}x${info.height}, tiles=${info.tileCount}, depth=${info.bitDepth}`);

const t0 = performance.now();
const img = decode(bytes, reduction, 0, 0, 0, 0);
const ms = performance.now() - t0;
const rgba = img.takeData();
console.log(`wasm decode reduce=${reduction}: ${img.width}x${img.height} in ${ms.toFixed(1)} ms`);

const ppm = join(mkdtempSync(join(tmpdir(), "j2k-")), "ref.ppm");
execFileSync("kdu_expand", ["-quiet", "-i", file, "-o", ppm, "-reduce", String(reduction)]);
const ref = readFileSync(ppm);
// Binary PPM: "P6\n<w> <h>\n255\n" then RGB.
const header = ref.subarray(0, 64).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
const [rw, rh] = [Number(header[1]), Number(header[2])];
const rgb = ref.subarray(header[0].length);
if (rw !== img.width || rh !== img.height) throw new Error(`size mismatch: kakadu ${rw}x${rh}`);

let maxDiff = 0, sumSq = 0;
for (let p = 0; p < rw * rh; p++) {
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(rgba[p * 4 + c] - rgb[p * 3 + c]);
    maxDiff = Math.max(maxDiff, d);
    sumSq += d * d;
  }
}
const mse = sumSq / (rw * rh * 3);
const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
console.log(`vs kakadu: max |diff|=${maxDiff}, PSNR=${psnr.toFixed(2)} dB`);
