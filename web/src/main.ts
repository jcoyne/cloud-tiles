import OpenSeadragon from "openseadragon";
import { DecoderPool } from "./decode/pool";
import { Jp2Image } from "./jp2/image";
import { HttpRangeSource } from "./net/range-source";
import { createJp2TileSource, type TileStats } from "./viewer/tile-source";

const SAMPLES: [label: string, url: string][] = [
  ["Stanford stacks: archive JP2 (remote)", "https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2"],
  ["Stanford stacks: 1.2 GB piano roll (remote)", "https://stacks.stanford.edu/file/kp368nb7707/kp368nb7707_0001.jp2"],
  ["Local: archive JP2 (untiled, PLT)", "/testdata/stanford-army.jp2"],
  ["Local: tiled 1024 HTJ2K", "/testdata/stanford-army-t1024-ht.jph"],
  ["Local: tiled 512 HTJ2K", "/testdata/stanford-army-t512-ht.jph"],
  ["Local: tiled 1024 J2K", "/testdata/stanford-army-t1024-j2k.jp2"],
  ["Local: untiled 256 precincts J2K", "/testdata/stanford-army-p256-j2k.jp2"],
];

const form = document.querySelector<HTMLFormElement>("#open")!;
const input = document.querySelector<HTMLInputElement>("#src")!;
const samples = document.querySelector<HTMLSelectElement>("#samples")!;
const hud = document.querySelector<HTMLElement>("#hud")!;

samples.append(new Option("Samples…", ""), ...SAMPLES.map(([label, url]) => new Option(label, url)));
samples.addEventListener("change", () => {
  if (samples.value) {
    input.value = new URL(samples.value, location.href).href;
    form.requestSubmit();
  }
});

const pool = new DecoderPool();
const viewer = OpenSeadragon({
  element: document.querySelector<HTMLElement>("#viewer")!,
  prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@6.1.1/build/openseadragon/images/",
  showNavigator: true,
  imageLoaderLimit: pool.size * 2,
  maxZoomPixelRatio: 2,
  timeout: 60_000,
});

// Exposed for scripted testing (scripts/screenshot.mjs).
(window as unknown as { viewer: OpenSeadragon.Viewer }).viewer = viewer;

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

async function open(url: string) {
  hud.textContent = `Opening ${url}…`;
  const t0 = performance.now();
  const source = new HttpRangeSource(url);
  let img: Jp2Image;
  try {
    img = await Jp2Image.open(source);
  } catch (err) {
    hud.innerHTML = "";
    const e = document.createElement("span");
    e.className = "err";
    e.textContent = `Failed to open: ${err instanceof Error ? err.message : err}`;
    hud.append(e);
    return;
  }
  const openMs = performance.now() - t0;
  const openStats = { ...source.stats };
  let tiles: TileStats = { tiles: 0, decodeMs: 0, failures: 0 };
  const { siz, cod } = img.header;
  const render = () => {
    const pct = ((100 * source.stats.bytes) / img.fileSize).toFixed(1);
    hud.textContent = [
      `${img.width} × ${img.height}, ${siz.components.length} comp, ${img.levels} levels, ${cod.layers} layers`,
      `${cod.progression}, tiles ${siz.numXTiles}×${siz.numYTiles} (${siz.xtsiz}×${siz.ytsiz}), ${cod.component.cblkStyle & 0x40 ? "HTJ2K" : "J2K"}`,
      `access: ${img.mode}${img.header.tlm ? ", TLM" : ""}${img.partsByResolution ? ", tile-parts by resolution" : ""}`,
      `open: ${openStats.requests} req, ${fmtBytes(openStats.bytes)}, ${openMs.toFixed(0)} ms`,
      `fetched: ${source.stats.requests} req, ${fmtBytes(source.stats.bytes)} of ${fmtBytes(img.fileSize)} (${pct}%)`,
      `decoded: ${tiles.tiles} tiles, avg ${(tiles.decodeMs / Math.max(1, tiles.tiles)).toFixed(1)} ms${tiles.failures ? `, ${tiles.failures} failed` : ""}`,
    ].join("\n");
  };
  source.onRequest = render;
  const tileSource = createJp2TileSource(img, source, pool, (s) => {
    tiles = s;
    render();
  });
  render();
  viewer.open(tileSource as unknown as OpenSeadragon.TileSourceSpecifier);
  const params = new URLSearchParams(location.search);
  params.set("src", url);
  history.replaceState(null, "", `?${params}`);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void open(input.value);
});

const initial = new URLSearchParams(location.search).get("src");
if (initial) {
  input.value = initial;
  void open(initial);
}
