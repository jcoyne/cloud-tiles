/**
 * OpenSeadragon tile source backed by range requests into a JP2/JPH file.
 *
 * OSD level L maps to dropping d = maxLevel - L JPEG 2000 resolution levels;
 * levels coarser than the codestream's lowest resolution are not offered.
 */

import OpenSeadragon from "openseadragon";
import type { DecoderPool } from "../decode/pool";
import type { Jp2Image } from "../jp2/image";
import type { HttpRangeSource } from "../net/range-source";

export interface TileStats {
  tiles: number;
  decodeMs: number;
  failures: number;
}

interface TileJob {
  postData: { level: number; x: number; y: number };
  userData: { abort?: AbortController };
  finish(data: unknown, request: unknown, type: string): void;
  fail(message: string, request: unknown): void;
}

/** Choose an OSD tile size: the JP2 tile size for tiled files, else 512. */
function tileSizeFor(img: Jp2Image): number {
  const s = img.header.siz;
  if (img.mode === "tiles" && s.numXTiles * s.numYTiles > 1 && s.xtsiz === s.ytsiz && s.xtsiz >= 256 && s.xtsiz <= 1024) {
    return s.xtsiz;
  }
  return 512;
}

export function createJp2TileSource(
  img: Jp2Image,
  source: HttpRangeSource,
  pool: DecoderPool,
  onTile?: (stats: TileStats) => void,
): OpenSeadragon.TileSource {
  const maxLevel = Math.ceil(Math.log2(Math.max(img.width, img.height)));
  const minLevel = Math.max(0, maxLevel - img.levels);
  const tileSize = tileSizeFor(img);
  const stats: TileStats = { tiles: 0, decodeMs: 0, failures: 0 };

  const ts = new OpenSeadragon.TileSource({
    width: img.width,
    height: img.height,
    tileSize,
    tileOverlap: 0,
    minLevel,
    maxLevel,
    ready: true,
  } as unknown as OpenSeadragon.TileSourceOptions);

  Object.assign(ts, {
    getTileUrl(level: number, x: number, y: number) {
      return `${source.url}#jp2/${level}/${x}/${y}`;
    },
    getTilePostData(level: number, x: number, y: number) {
      return { level, x, y };
    },
    getTileHashKey(level: number, x: number, y: number) {
      return `${source.url}#jp2/${level}/${x}/${y}`;
    },
    hasTransparency() {
      return false;
    },
    downloadTileStart(job: TileJob) {
      const { level, x, y } = job.postData;
      const d = maxLevel - level;
      const { width, height } = img.reducedSize(d);
      const rx = x * tileSize;
      const ry = y * tileSize;
      const region = { x: rx, y: ry, w: Math.min(tileSize, width - rx), h: Math.min(tileSize, height - ry) };
      const abort = new AbortController();
      job.userData.abort = abort;
      (async () => {
        const plan = img.plan(d, region);
        // Fetches are shared between tiles, so don't cancel them; just stop here.
        await source.ensure(plan.ranges);
        abort.signal.throwIfAborted();
        const codestream = plan.build(source.readCached);
        const out = await pool.decode(codestream, plan.reduction, plan.region, plan.pixels, abort.signal);
        stats.tiles++;
        stats.decodeMs += out.ms;
        onTile?.(stats);
        let data: unknown = out.bitmap;
        let type = "imageBitmap";
        if (!data && out.rgba) {
          const canvas = document.createElement("canvas");
          canvas.width = out.width;
          canvas.height = out.height;
          const ctx = canvas.getContext("2d")!;
          ctx.putImageData(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
          data = ctx;
          type = "context2d";
        }
        job.finish(data, null, type);
      })().catch((err: unknown) => {
        if (abort.signal.aborted) return job.fail("aborted", null);
        stats.failures++;
        onTile?.(stats);
        console.error(`tile ${level}/${x}/${y}`, err);
        job.fail(String(err instanceof Error ? err.message : err), null);
      });
    },
    downloadTileAbort(job: TileJob) {
      job.userData.abort?.abort();
    },
  });
  return ts;
}
