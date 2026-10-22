/**
 * IIIF Presentation 3 manifest for a single range-readable JPEG 2000 file.
 *
 * The painting annotation's body is the file itself. A custom service marks it
 * as readable by byte range (TLM or PLT present) so capable viewers can skip
 * the image server; for stacks.stanford.edu files the existing Image API
 * service is listed too, so viewers that only speak the Image API still work.
 * See docs/iiif.md.
 */

import type { Jp2Image } from "../jp2/image";

export const RANGE_SERVICE_TYPE = "https://github.com/jcoyne/cloud-tiles/ns/RangeJP2";

const STACKS_FILE = /^https:\/\/stacks\.stanford\.edu\/file\/(?:druid:)?([a-z]{2}\d{3}[a-z]{2}\d{4})\/(.+)\.(?:jp2|jph|j2c|jhc)$/;

function format(img: Jp2Image): string {
  const ht = (img.header.cod.component.cblkStyle & 0x40) !== 0;
  if (img.layout.kind === "j2c") return ht ? "image/jphc" : "image/j2c";
  return ht ? "image/jph" : "image/jp2";
}

/** Image API 2 service on stacks.stanford.edu for a stacks file URL, if any. */
function stacksImageService(url: string): string | null {
  const m = STACKS_FILE.exec(url);
  return m ? `https://stacks.stanford.edu/image/iiif/${m[1]}%2F${encodeURIComponent(m[2])}` : null;
}

export function buildManifest(url: string, img: Jp2Image): object {
  const base = `${url}/iiif`;
  const canvas = `${base}/canvas/1`;
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  const { siz, cod } = img.header;
  const imageService = stacksImageService(url);

  const services: object[] = [
    {
      id: url,
      type: RANGE_SERVICE_TYPE,
      profile: `${RANGE_SERVICE_TYPE}/${img.header.tlm ? "tlm" : "plt"}`,
      // Hints that let a client plan requests before reading the header.
      indexBytes: img.indexBytes,
      fileSize: img.fileSize,
      tileSize: [siz.xtsiz, siz.ytsiz],
      levels: img.levels,
      layers: cod.layers,
    },
  ];
  if (imageService) services.push({ "@id": imageService, "@type": "ImageService2", profile: "level2" });

  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: `${base}/manifest`,
    type: "Manifest",
    label: { none: [name] },
    ...(imageService && {
      thumbnail: [
        {
          id: `${imageService}/full/!400,400/0/default.jpg`,
          type: "Image",
          format: "image/jpeg",
          service: [{ "@id": imageService, "@type": "ImageService2", profile: "level2" }],
        },
      ],
    }),
    items: [
      {
        id: canvas,
        type: "Canvas",
        width: img.width,
        height: img.height,
        items: [
          {
            id: `${canvas}/page/1`,
            type: "AnnotationPage",
            items: [
              {
                id: `${canvas}/page/1/annotation/1`,
                type: "Annotation",
                motivation: "painting",
                target: canvas,
                body: {
                  id: url,
                  type: "Image",
                  format: format(img),
                  width: img.width,
                  height: img.height,
                  service: services,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const JP2_FORMATS = new Set(["image/jp2", "image/jph", "image/j2c", "image/jphc", "image/jpx"]);
const STACKS_IMAGE = /^https:\/\/stacks\.stanford\.edu\/image\/iiif\/([a-z]{2}\d{3}[a-z]{2}\d{4})(?:%2F|\/)([^/]+)$/;

export interface ImageServiceRef {
  id: string;
  version: 2 | 3;
}

/** How the viewer can display one canvas. */
export interface CanvasEntry {
  label: string;
  width?: number;
  height?: number;
  /** JP2/JPH to read by byte range, if the body is (or can be mapped to) one. */
  range?: { url: string; reason: string };
  imageService?: ImageServiceRef;
  /** Plain image URL, last resort. */
  image?: string;
}

export interface ParsedManifest {
  label: string;
  canvases: CanvasEntry[];
}

type Json = Record<string, unknown>;

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : v ? [v] : []) as Json[];
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** First string in a language map (`{ en: ["..."] }`), or a plain string. */
function langString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    for (const vals of Object.values(v)) if (Array.isArray(vals) && typeof vals[0] === "string") return vals[0];
  }
  return undefined;
}

function serviceType(s: Json): string {
  return str(s.type) ?? str(s["@type"]) ?? "";
}

function imageService(services: Json[]): ImageServiceRef | undefined {
  for (const s of services) {
    const id = str(s.id) ?? str(s["@id"]);
    const type = serviceType(s);
    const profile = String(arr(s.profile)[0] ?? s.profile ?? "");
    if (!id) continue;
    if (type === "ImageService3") return { id, version: 3 };
    if (type === "ImageService2" || profile.includes("iiif.io/api/image/2")) return { id, version: 2 };
  }
  return undefined;
}

/** The stacks file behind a Stanford Image API service (archive JP2s carry PLT). */
function stacksFileFor(service: ImageServiceRef): string | undefined {
  const m = STACKS_IMAGE.exec(service.id);
  return m ? `https://stacks.stanford.edu/file/${m[1]}/${m[2]}.jp2` : undefined;
}

function canvasEntry(canvas: Json, index: number, base: string): CanvasEntry {
  const label = langString(canvas.label) ?? `Canvas ${index + 1}`;
  const entry: CanvasEntry = { label, width: canvas.width as number, height: canvas.height as number };
  const painting = arr(canvas.items)
    .flatMap((page) => arr(page.items))
    .find((a) => [a.motivation].flat().includes("painting"));
  // A Choice body: take its first item.
  let body = arr(painting?.body)[0];
  if (body && body.type === "Choice") body = arr(body.items)[0];
  if (!body) return entry;

  const id = str(body.id) ? new URL(str(body.id)!, base).href : undefined;
  const services = arr(body.service);
  entry.imageService = imageService(services);
  const rangeService = services.find((s) => serviceType(s) === RANGE_SERVICE_TYPE);
  const fmt = str(body.format) ?? "";

  if (rangeService && (str(rangeService.id) ?? id)) {
    entry.range = { url: new URL(str(rangeService.id) ?? id!, base).href, reason: "RangeJP2 service" };
  } else if (id && JP2_FORMATS.has(fmt)) {
    entry.range = { url: id, reason: `body format ${fmt}` };
  } else if (entry.imageService && stacksFileFor(entry.imageService)) {
    entry.range = { url: stacksFileFor(entry.imageService)!, reason: "mapped from Stanford Image API service" };
  }
  if (id && !JP2_FORMATS.has(fmt)) entry.image = id;
  return entry;
}

/** Read a Presentation 3 manifest into the canvases the viewer can show. */
export function parseManifest(json: unknown, base: string): ParsedManifest {
  const m = json as Json;
  if (m.type !== "Manifest") throw new Error("not a IIIF Presentation 3 manifest");
  return {
    label: langString(m.label) ?? "Untitled manifest",
    canvases: arr(m.items)
      .filter((c) => c.type === "Canvas")
      .map((c, i) => canvasEntry(c, i, base)),
  };
}
