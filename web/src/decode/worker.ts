/// <reference lib="webworker" />
import init, { decode } from "../wasm-pkg/j2k.js";
import type { DecodeRequest, DecodeResponse } from "./protocol";

const ready = init();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, codestream, reduction, region } = e.data;
  try {
    await ready;
    const t0 = performance.now();
    const img = decode(codestream, reduction, region.x, region.y, region.w, region.h);
    const { width, height } = img;
    const rgba = new Uint8ClampedArray(img.takeData().buffer as ArrayBuffer);
    img.free();
    const ms = performance.now() - t0;
    let msg: DecodeResponse;
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
      msg = { id, ok: true, width, height, bitmap, ms };
      scope.postMessage(msg, [bitmap]);
    } else {
      msg = { id, ok: true, width, height, rgba, ms };
      scope.postMessage(msg, [rgba.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err instanceof Error ? err.message : err) } satisfies DecodeResponse);
  }
};
