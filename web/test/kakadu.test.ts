// Compare synthesized decodes of the 1.2 GB scroll with kdu_expand regions.
// j2k and Kakadu differ by at most 1 per sample; boundary or packet errors
// from synthesis would show up as much larger differences.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Jp2Image } from "../src/jp2/image";
import { decodeRGBA, fixture, hasFixture, sourceFor } from "./helpers";

const NAME = "kp368nb7707_0001.jp2";
const hasKakadu = (() => {
  try {
    execFileSync("kdu_expand", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function kakaduRegion(file: string, d: number, x: number, y: number, w: number, h: number, W: number, H: number) {
  const k = 2 ** d;
  const out = join(mkdtempSync(join(tmpdir(), "kdu-")), "r.ppm");
  // -region takes {top,left},{height,width} as fractions of the full image.
  const region = `{${(y * k) / H},${(x * k) / W}},{${(h * k) / H},${(w * k) / W}}`;
  execFileSync("kdu_expand", ["-quiet", "-i", file, "-o", out, "-reduce", String(d), "-region", region]);
  const ppm = readFileSync(out);
  const m = ppm.subarray(0, 64).toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
  return { width: Number(m[1]), height: Number(m[2]), rgb: ppm.subarray(m[0].length) };
}

// [reduction, x, y, w, h] in reduced pixels; several sit next to the
// 4096-row (full-res) window boundaries.
const CASES: [number, number, number, number, number][] = [
  [5, 0, 0, 128, 512],
  [5, 0, 7000, 128, 512],
  [4, 0, 3800, 256, 512],
  [3, 0, 10000, 512, 512],
  [2, 0, 1000, 1024, 1024],
  [1, 512, 2000, 512, 512],
  [0, 1024, 120000, 512, 512],
  [0, 0, 122600, 512, 512],
  [0, 3584, 8100, 512, 200],
  [0, 2000, 252600, 512, 240],
];

describe.runIf(hasKakadu && hasFixture(NAME))(NAME, () => {
  it.each(CASES)("matches Kakadu (reduce %i @%i,%i %ix%i)", async (d, x, y, w, h) => {
    const src = sourceFor(NAME);
    const img = await Jp2Image.open(src);
    const plan = img.plan(d, { x, y, w, h });
    await src.ensure(plan.ranges);
    const got = decodeRGBA(plan.build(src.readCached), plan.reduction, plan.region.x, plan.region.y, plan.region.w, plan.region.h);
    const ref = kakaduRegion(fixture(NAME), d, x, y, w, h, img.width, img.height);
    expect([ref.width, ref.height]).toEqual([w, h]);
    let max = 0;
    for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(got.data[p * 4 + c] - ref.rgb[p * 3 + c]));
    expect(max).toBeLessThanOrEqual(1);
  });
});
