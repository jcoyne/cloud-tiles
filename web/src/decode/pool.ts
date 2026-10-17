/**
 * A pool of decode workers, one WASM instance each. Jobs are queued FIFO
 * and can be cancelled while still queued.
 *
 * j2k's memory use scales with the area of the synthesized image, and a WASM
 * instance never returns memory once grown, so large jobs all go to one
 * dedicated worker (worker 0) instead of growing every instance.
 */

import type { Region } from "../jp2/image";
import type { DecodeRequest, DecodeResponse } from "./protocol";

type Done = Extract<DecodeResponse, { ok: true }>;

/** Jobs above this many samples per component only run on the large worker. */
export const LARGE_JOB_PIXELS = 8 * 1024 * 1024;

interface Job {
  req: DecodeRequest;
  large: boolean;
  resolve: (r: Done) => void;
  reject: (e: Error) => void;
}

export class DecoderPool {
  private readonly workers: Worker[] = [];
  private idle = new Set<Worker>();
  private busy = new Map<Worker, Job>();
  private queue: Job[] = [];
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: i === 0 ? "j2k-large" : `j2k-${i}` });
      w.onmessage = (e: MessageEvent<DecodeResponse>) => this.onMessage(w, e.data);
      w.onerror = (e) => this.onMessage(w, { id: -1, ok: false, error: e.message || "worker error" });
      this.workers.push(w);
      this.idle.add(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  decode(codestream: Uint8Array, reduction: number, region: Region, pixels: number, signal?: AbortSignal): Promise<Done> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        req: { id: this.nextId++, codestream, reduction, region },
        large: pixels > LARGE_JOB_PIXELS,
        resolve,
        reject,
      };
      signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    // Small workers first, so the large worker stays free for large jobs.
    for (const w of [...this.workers].reverse()) {
      if (!this.idle.has(w)) continue;
      const i = this.queue.findIndex((j) => !j.large || w === this.workers[0]);
      if (i < 0) continue;
      const [job] = this.queue.splice(i, 1);
      this.idle.delete(w);
      this.busy.set(w, job);
      w.postMessage(job.req, [job.req.codestream.buffer as ArrayBuffer]);
    }
  }

  private onMessage(w: Worker, msg: DecodeResponse) {
    const job = this.busy.get(w);
    this.busy.delete(w);
    this.idle.add(w);
    if (job) {
      if (msg.ok) job.resolve(msg);
      else job.reject(new Error(msg.error));
    }
    this.pump();
  }
}
