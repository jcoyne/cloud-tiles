/**
 * A pool of decode workers, one WASM instance each. Jobs are queued FIFO
 * and can be cancelled while still queued.
 */

import type { Region } from "../jp2/image";
import type { DecodeRequest, DecodeResponse } from "./protocol";

type Done = Extract<DecodeResponse, { ok: true }>;

interface Job {
  req: DecodeRequest;
  resolve: (r: Done) => void;
  reject: (e: Error) => void;
}

export class DecoderPool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, Job>();
  private queue: Job[] = [];
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<DecodeResponse>) => this.onMessage(w, e.data);
      w.onerror = (e) => this.onMessage(w, { id: -1, ok: false, error: e.message || "worker error" });
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.idle.length + this.busy.size;
  }

  decode(codestream: Uint8Array, reduction: number, region: Region, signal?: AbortSignal): Promise<Done> {
    return new Promise((resolve, reject) => {
      const job: Job = { req: { id: this.nextId++, codestream, reduction, region }, resolve, reject };
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
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(w, job);
      w.postMessage(job.req, [job.req.codestream.buffer as ArrayBuffer]);
    }
  }

  private onMessage(w: Worker, msg: DecodeResponse) {
    const job = this.busy.get(w);
    this.busy.delete(w);
    this.idle.push(w);
    if (job) {
      if (msg.ok) job.resolve(msg);
      else job.reject(new Error(msg.error));
    }
    this.pump();
  }
}
