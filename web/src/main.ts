import OpenSeadragon from "openseadragon";
import { DecoderPool } from "./decode/pool";
import { buildManifest, parseManifest, type CanvasEntry, type ParsedManifest } from "./iiif/manifest";
import { Jp2Image } from "./jp2/image";
import { HttpRangeSource } from "./net/range-source";
import { createJp2TileSource, type TileStats } from "./viewer/tile-source";

const REMOTE_SAMPLES: [label: string, url: string][] = [
  ["Stanford stacks: archive JP2 (remote)", "https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2"],
  ["Stanford stacks: 1.2 GB piano roll (remote)", "https://stacks.stanford.edu/file/kp368nb7707/kp368nb7707_0001.jp2"],
  ["IIIF: Stanford PURL manifest (remote)", "https://purl.stanford.edu/bb002wb0348/iiif3/manifest"],
];
// Served from ../testdata by the dev server only (vite.config.ts).
const LOCAL_SAMPLES: [label: string, url: string][] = [
  ["IIIF: example manifest (local + remote)", "/manifests/example.json"],
  ["Local: archive JP2 (untiled, PLT)", "/testdata/stanford-army.jp2"],
  ["Local: tiled 1024 HTJ2K", "/testdata/stanford-army-t1024-ht.jph"],
  ["Local: tiled 512 HTJ2K", "/testdata/stanford-army-t512-ht.jph"],
  ["Local: tiled 1024 J2K", "/testdata/stanford-army-t1024-j2k.jp2"],
  ["Local: untiled 256 precincts J2K", "/testdata/stanford-army-p256-j2k.jp2"],
];
const SAMPLES = import.meta.env.DEV ? [...REMOTE_SAMPLES, ...LOCAL_SAMPLES] : REMOTE_SAMPLES;

const form = document.querySelector<HTMLFormElement>("#open")!;
const input = document.querySelector<HTMLInputElement>("#src")!;
const samples = document.querySelector<HTMLSelectElement>("#samples")!;
const canvasSelect = document.querySelector<HTMLSelectElement>("#canvases")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const showManifest = document.querySelector<HTMLButtonElement>("#show-manifest")!;
const manifestDialog = document.querySelector<HTMLDialogElement>("#manifest-dialog")!;
const manifestTitle = document.querySelector<HTMLElement>("#manifest-title")!;
const manifestJson = document.querySelector<HTMLElement>("#manifest-json")!;
const copyManifest = document.querySelector<HTMLButtonElement>("#copy-manifest")!;

samples.append(new Option("Samples…", ""), ...SAMPLES.map(([label, url]) => new Option(label, url)));
samples.addEventListener("change", () => {
  if (samples.value) {
    input.value = new URL(samples.value, location.href).href;
    form.requestSubmit();
  }
});

showManifest.addEventListener("click", () => manifestDialog.showModal());
manifestDialog.addEventListener("click", (e) => {
  if (e.target === manifestDialog) manifestDialog.close();
});
copyManifest.addEventListener("click", async () => {
  await navigator.clipboard.writeText(manifestJson.textContent ?? "");
  copyManifest.textContent = "Copied";
  setTimeout(() => (copyManifest.textContent = "Copy"), 1500);
});

function setManifest(title: string, json: unknown) {
  manifestTitle.textContent = title;
  manifestJson.textContent = JSON.stringify(json, null, 2);
  showManifest.disabled = false;
}

const pool = new DecoderPool();
const viewer = OpenSeadragon({
  element: document.querySelector<HTMLElement>("#viewer")!,
  prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@6.1.1/build/openseadragon/images/",
  showNavigator: true,
  imageLoaderLimit: pool.size * 2,
  maxZoomPixelRatio: 2,
  timeout: 60_000,
  // Image API tiles are cross-origin; the WebGL drawer can't use them otherwise.
  crossOriginPolicy: "Anonymous",
});

// Exposed for scripted testing (scripts/screenshot.mjs).
(window as unknown as { viewer: OpenSeadragon.Viewer }).viewer = viewer;

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function showError(message: string) {
  hud.innerHTML = "";
  const e = document.createElement("span");
  e.className = "err";
  e.textContent = message;
  hud.append(e);
}

function setParams(entries: Record<string, string | null>) {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(entries)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  history.replaceState(null, "", `?${params}`);
}

// Bumped on every open so a slow open can't replace a newer one.
let generation = 0;

/** Open a JP2/JPH by byte range. `context` lines are prepended to the HUD. */
async function openRange(url: string, context: string[] = []): Promise<Jp2Image> {
  const gen = generation;
  const t0 = performance.now();
  const source = new HttpRangeSource(url);
  const img = await Jp2Image.open(source);
  if (gen !== generation) return img;
  const openMs = performance.now() - t0;
  const openStats = { ...source.stats };
  let tiles: TileStats = { tiles: 0, decodeMs: 0, failures: 0 };
  const { siz, cod } = img.header;
  const render = () => {
    if (gen !== generation) return;
    const pct = ((100 * source.stats.bytes) / img.fileSize).toFixed(1);
    hud.textContent = [
      ...context,
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
  return img;
}

async function openFile(url: string) {
  generation++;
  hud.textContent = `Opening ${url}…`;
  showManifest.disabled = true;
  canvasSelect.hidden = true;
  setParams({ src: url, manifest: null, canvas: null });
  try {
    const img = await openRange(url);
    setManifest("IIIF Presentation 3 manifest (generated)", buildManifest(url, img));
  } catch (err) {
    showError(`Failed to open: ${errMessage(err)}`);
  }
}

/** Show one canvas: by range if possible, else the Image API, else a plain image. */
async function openCanvas(entry: CanvasEntry, n: number, total: number) {
  const gen = ++generation;
  const head = `canvas ${n + 1}/${total}: ${entry.label}`;
  hud.textContent = `${head}\nOpening…`;
  let fallback = "";
  if (entry.range) {
    try {
      await openRange(entry.range.url, [head, `path: byte ranges (${entry.range.reason})`]);
      return;
    } catch (err) {
      fallback = ` (byte ranges failed: ${errMessage(err)})`;
    }
  }
  if (gen !== generation) return;
  if (entry.imageService) {
    viewer.open(`${entry.imageService.id.replace(/\/$/, "")}/info.json` as unknown as OpenSeadragon.TileSourceSpecifier);
    hud.textContent = [head, `path: IIIF Image API ${entry.imageService.version}${fallback}`, entry.imageService.id].join("\n");
  } else if (entry.image) {
    viewer.open({ type: "image", url: entry.image } as unknown as OpenSeadragon.TileSourceSpecifier);
    hud.textContent = [head, `path: plain image${fallback}`, entry.image].join("\n");
  } else {
    showError(`${head}\nNothing displayable${fallback}`);
  }
}

let manifest: ParsedManifest | null = null;

canvasSelect.addEventListener("change", () => {
  if (!manifest) return;
  const n = Number(canvasSelect.value);
  setParams({ canvas: String(n + 1) });
  void openCanvas(manifest.canvases[n], n, manifest.canvases.length);
});

async function openManifest(url: string, canvas = 0) {
  url = new URL(url, location.href).href;
  generation++;
  hud.textContent = `Loading manifest ${url}…`;
  showManifest.disabled = true;
  canvasSelect.hidden = true;
  setParams({ manifest: url, src: null, canvas: canvas ? String(canvas + 1) : null });
  let json: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
    manifest = parseManifest(json, url);
  } catch (err) {
    showError(`Failed to load manifest: ${errMessage(err)}`);
    return;
  }
  setManifest(`IIIF manifest: ${manifest.label}`, json);
  if (manifest.canvases.length === 0) return showError("Manifest has no canvases");
  const n = Math.min(Math.max(0, canvas), manifest.canvases.length - 1);
  canvasSelect.replaceChildren(...manifest.canvases.map((c, i) => new Option(`${i + 1}. ${c.label}`, String(i))));
  canvasSelect.value = String(n);
  canvasSelect.hidden = manifest.canvases.length < 2;
  await openCanvas(manifest.canvases[n], n, manifest.canvases.length);
}

/** Heuristic: manifests are JSON documents, typically named so. */
const looksLikeManifest = (url: string) => /\.json(\?|$)|manifest/i.test(url);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = input.value;
  void (looksLikeManifest(url) ? openManifest(url) : openFile(url));
});

const params = new URLSearchParams(location.search);
const initialManifest = params.get("manifest");
const initialSrc = params.get("src");
if (initialManifest) {
  input.value = initialManifest;
  void openManifest(initialManifest, Number(params.get("canvas") ?? 1) - 1);
} else if (initialSrc) {
  input.value = initialSrc;
  void openFile(initialSrc);
}
