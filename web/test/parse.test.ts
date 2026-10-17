import { describe, expect, it } from "vitest";
import { Jp2Image } from "../src/jp2/image";
import { hasFixture, sourceFor } from "./helpers";

describe.runIf(hasFixture("stanford-army.jp2"))("Stanford archive JP2", () => {
  it("parses header and builds a precinct index from PLT", async () => {
    const src = sourceFor("stanford-army.jp2");
    const img = await Jp2Image.open(src);
    const { siz, cod } = img.header;
    expect([img.width, img.height]).toEqual([6000, 4000]);
    expect(siz.numXTiles * siz.numYTiles).toBe(1);
    expect(cod.progression).toBe("RPCL");
    expect(cod.layers).toBe(7);
    expect(img.levels).toBe(5);
    expect(img.header.tlm).toBeNull();
    expect(img.mode).toBe("precincts");
    // Only the headers were read.
    expect(src.stats.bytes).toBeLessThan(128 * 1024);
  });
});

describe.runIf(hasFixture("stanford-army-t1024-ht.jph"))("Kakadu tiled HTJ2K", () => {
  it("uses TLM and detects resolution tile-parts", async () => {
    const src = sourceFor("stanford-army-t1024-ht.jph");
    const img = await Jp2Image.open(src);
    expect(img.mode).toBe("tiles");
    expect(img.header.tlm).toHaveLength(24 * 7);
    expect(img.partsByResolution).toBe(true);
    expect(src.stats.requests).toBe(1);
  });
});
