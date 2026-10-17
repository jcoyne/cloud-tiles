// Network tests against stacks.stanford.edu. Run with: REMOTE=1 npx vitest run test/remote.test.ts
import { describe, expect, it } from "vitest";
import { Jp2Image } from "../src/jp2/image";
import { HttpRangeSource } from "../src/net/range-source";
import { decodeRGBA } from "./helpers";

const KP = "https://stacks.stanford.edu/file/kp368nb7707/kp368nb7707_0001.jp2";

describe.runIf(process.env.REMOTE)("kp368nb7707 (1.2 GB, 4096x252840, untiled)", () => {
  it("opens and decodes regions at several resolutions", async () => {
    const src = new HttpRangeSource(KP);
    let t0 = performance.now();
    const img = await Jp2Image.open(src);
    process.stderr.write("\n" + `open: ${src.stats.requests} req, ${src.stats.bytes} bytes, ${(performance.now() - t0).toFixed(0)} ms, mode=${img.mode}` + "\n");
    expect([img.width, img.height]).toEqual([4096, 252840]);
    for (const [d, x, y, w, h] of [
      [5, 0, 0, 128, 512],
      [3, 0, 10000, 512, 512],
      [0, 1024, 120000, 512, 512],
    ]) {
      const before = { ...src.stats };
      t0 = performance.now();
      const plan = img.plan(d, { x, y, w, h });
      await src.ensure(plan.ranges);
      const tFetch = performance.now() - t0;
      const cs = plan.build(src.readCached);
      const t1 = performance.now();
      const out = decodeRGBA(cs, plan.reduction, plan.region.x, plan.region.y, plan.region.w, plan.region.h);
      process.stderr.write("\n" + 
        `d=${d} @${x},${y}: ${src.stats.requests - before.requests} req, ${src.stats.bytes - before.bytes} bytes, ` +
          `fetch ${tFetch.toFixed(0)} ms, codestream ${cs.length} bytes, decode ${(performance.now() - t1).toFixed(0)} ms\n`,
      );
      expect([out.width, out.height]).toEqual([w, h]);
    }
  }, 300_000);
});
