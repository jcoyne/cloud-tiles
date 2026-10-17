import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Jp2Image } from "../src/jp2/image";
import { decodeRGBA, fixture, hasFixture, maxDiff, sourceFor } from "./helpers";

const FILES = [
  "stanford-army.jp2",
  "stanford-army-p256-j2k.jp2",
  "stanford-army-t1024-j2k.jp2",
  "stanford-army-t512-j2k.jp2",
  "stanford-army-t1024-ht.jph",
  "stanford-army-t512-ht.jph",
].filter(hasFixture);

// [reduction, x, y, w, h] in reduced pixels.
const CASES: [number, number, number, number, number][] = [
  [5, 0, 0, 188, 125],
  [3, 0, 0, 750, 500],
  [2, 256, 256, 512, 512],
  [1, 1500, 1000, 512, 512],
  [0, 2048, 1024, 512, 512],
  [0, 5800, 3900, 200, 100],
  [0, 3000, 2000, 777, 333],
];

describe.each(FILES)("%s", (name) => {
  it.each(CASES)("synthesized decode matches full-file decode (reduce %i @%i,%i %ix%i)", async (d, x, y, w, h) => {
    const src = sourceFor(name);
    const img = await Jp2Image.open(src);
    const plan = img.plan(d, { x, y, w, h });
    await src.ensure(plan.ranges);
    const cs = plan.build(src.readCached);
    const got = decodeRGBA(cs, d, plan.region.x, plan.region.y, plan.region.w, plan.region.h);
    const want = decodeRGBA(readFileSync(fixture(name)), d, x, y, w, h);
    expect([got.width, got.height]).toEqual([w, h]);
    expect(maxDiff(got.data, want.data)).toBe(0);
    expect(src.stats.bytes).toBeLessThan(img.fileSize);
  });
});
