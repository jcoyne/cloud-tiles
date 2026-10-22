import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManifest, parseManifest } from "../src/iiif/manifest";
import { Jp2Image } from "../src/jp2/image";
import { hasFixture, sourceFor } from "./helpers";

const ARMY_SERVICE = "https://stacks.stanford.edu/image/iiif/bb002wb0348%2FPC0170_s3_Army_2014-09-13_122754_0529";

function manifestWith(body: object) {
  return {
    type: "Manifest",
    label: { en: ["m"] },
    items: [{ type: "Canvas", items: [{ type: "AnnotationPage", items: [{ type: "Annotation", motivation: "painting", body }] }] }],
  };
}

describe("parseManifest", () => {
  it("reads the example manifest's four access paths", () => {
    const json = JSON.parse(readFileSync(new URL("../public/manifests/example.json", import.meta.url), "utf8"));
    const m = parseManifest(json, "http://localhost:5173/manifests/example.json");
    expect(m.canvases.map((c) => c.range?.reason)).toEqual([
      "body format image/jp2",
      "RangeJP2 service",
      "mapped from Stanford Image API service",
      "RangeJP2 service",
    ]);
    expect(m.canvases[0].range?.url).toBe("http://localhost:5173/testdata/stanford-army.jp2");
    expect(m.canvases[2].range?.url).toBe("https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2");
    expect(m.canvases[3].imageService?.version).toBe(2);
  });

  it("falls back to the Image API or a plain image for non-JP2 bodies", () => {
    const svc = "https://example.org/iiif/abc";
    const withService = parseManifest(manifestWith({ id: `${svc}/full/max/0/default.jpg`, type: "Image", format: "image/jpeg", service: [{ id: svc, type: "ImageService3" }] }), svc);
    expect(withService.canvases[0].range).toBeUndefined();
    expect(withService.canvases[0].imageService).toEqual({ id: svc, version: 3 });
    const plain = parseManifest(manifestWith({ id: "https://example.org/a.png", type: "Image", format: "image/png" }), svc);
    expect(plain.canvases[0]).toEqual({ label: "Canvas 1", width: undefined, height: undefined, imageService: undefined, image: "https://example.org/a.png" });
  });

  it("accepts Image API 2 services in v2 form", () => {
    const m = parseManifest(manifestWith({ id: "x.jpg", type: "Image", format: "image/jpeg", service: [{ "@id": ARMY_SERVICE, "@type": "ImageService2" }] }), "https://example.org/");
    expect(m.canvases[0].imageService).toEqual({ id: ARMY_SERVICE, version: 2 });
    expect(m.canvases[0].range?.reason).toBe("mapped from Stanford Image API service");
  });

  it("rejects non-manifests", () => {
    expect(() => parseManifest({ type: "Collection" }, "https://example.org/")).toThrow();
  });
});

describe.skipIf(!hasFixture("stanford-army.jp2"))("buildManifest", () => {
  it("round-trips through parseManifest", async () => {
    const url = "https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2";
    const img = await Jp2Image.open(sourceFor("stanford-army.jp2"));
    const m = parseManifest(buildManifest(url, img), url);
    expect(m.canvases[0]).toMatchObject({
      width: 6000,
      height: 4000,
      range: { url, reason: "RangeJP2 service" },
      imageService: { id: ARMY_SERVICE, version: 2 },
    });
  });
});
