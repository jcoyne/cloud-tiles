/**
 * HTTP range-request byte source with a span cache.
 *
 * Fetched spans are kept (up to a byte budget, LRU) so that data shared by
 * many tiles, such as low-resolution tile-parts and precincts, is fetched
 * once. Concurrent requests for overlapping bytes share one fetch.
 */

import { coalesce, type ByteRange, type ByteSource } from "../jp2/image";

export interface RangeStats {
  requests: number;
  bytes: number;
}

interface Span {
  start: number;
  end: number;
  data: Uint8Array;
  used: number;
}

export interface RangeSourceOptions {
  /** Max concurrent HTTP requests. */
  concurrency?: number;
  /** Cache budget in bytes. */
  cacheBytes?: number;
  /** Merge ranges separated by at most this many bytes into one request. */
  gap?: number;
  fetch?: typeof fetch;
}

export class HttpRangeSource implements ByteSource {
  readonly stats: RangeStats = { requests: 0, bytes: 0 };
  private spans: Span[] = []; // sorted by start, non-overlapping
  private pending: { start: number; end: number; done: Promise<void> }[] = [];
  private cached = 0;
  private clock = 0;
  private active = 0;
  private queue: (() => void)[] = [];
  private total: number | null = null;
  private etag: string | null = null;
  private readonly concurrency: number;
  private readonly cacheBytes: number;
  private readonly gap: number;
  private readonly fetchFn: typeof fetch;
  /** Called after every completed HTTP request. */
  onRequest?: (stats: RangeStats) => void;

  constructor(
    readonly url: string,
    opts: RangeSourceOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 6;
    this.cacheBytes = opts.cacheBytes ?? 256 * 1024 * 1024;
    this.gap = opts.gap ?? 8 * 1024;
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis);
  }

  async size(): Promise<number> {
    if (this.total === null) await this.ensure([[0, 64 * 1024]]);
    return this.total!;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (this.total !== null) end = Math.min(end, this.total);
    await this.ensure([[start, end]]);
    return this.readCached(start, end);
  }

  /** Copy (or view) already-cached bytes; throws if any are missing. */
  readCached = (start: number, end: number): Uint8Array => {
    if (this.total !== null) end = Math.min(end, this.total);
    let i = this.findSpan(start);
    const s = this.spans[i];
    if (s && s.start <= start && s.end >= end) {
      s.used = ++this.clock;
      return s.data.subarray(start - s.start, end - s.start);
    }
    // Stitch adjacent spans.
    const out = new Uint8Array(end - start);
    let at = start;
    while (at < end) {
      const sp = this.spans[i];
      if (!sp || sp.start > at || sp.end <= at) throw new Error(`bytes ${at}-${end} not cached`);
      const n = Math.min(sp.end, end) - at;
      out.set(sp.data.subarray(at - sp.start, at - sp.start + n), at - start);
      sp.used = ++this.clock;
      at += n;
      i++;
    }
    return out;
  };

  /** Fetch whatever part of `ranges` is not cached or already in flight. */
  async ensure(ranges: ByteRange[], signal?: AbortSignal): Promise<void> {
    const waits: Promise<void>[] = [];
    const missing: ByteRange[] = [];
    for (const [s, e] of ranges) {
      for (const gap of this.gaps(s, this.total === null ? e : Math.min(e, this.total))) {
        // Subtract in-flight requests.
        let pieces: ByteRange[] = [gap];
        for (const p of this.pending) {
          if (p.start < gap[1] && gap[0] < p.end) waits.push(p.done);
          pieces = pieces.flatMap(([a, b]) => {
            if (p.end <= a || p.start >= b) return [[a, b] as ByteRange];
            const out: ByteRange[] = [];
            if (a < p.start) out.push([a, p.start]);
            if (p.end < b) out.push([p.end, b]);
            return out;
          });
        }
        missing.push(...pieces);
      }
    }
    for (const [s, e] of coalesce(missing.filter(([a, b]) => b > a), this.gap)) {
      const done = this.fetchRange(s, e, signal);
      const entry = { start: s, end: e, done };
      this.pending.push(entry);
      waits.push(done);
      done.finally(() => (this.pending = this.pending.filter((p) => p !== entry))).catch(() => {});
    }
    await Promise.all(waits);
  }

  private async fetchRange(start: number, end: number, signal?: AbortSignal): Promise<void> {
    await this.acquire();
    try {
      // Only a single "bytes=a-b" Range is CORS-safelisted, so avoid If-Range
      // (it would force a preflight) and compare ETags on responses instead.
      const res = await this.fetchFn(this.url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
      const etag = res.headers.get("ETag");
      if (etag && this.etag && etag !== this.etag) throw new Error(`${this.url} changed while being read`);
      if (etag) this.etag = etag;
      if (res.status === 200) {
        // Server ignored Range: cache the whole body.
        const data = new Uint8Array(await res.arrayBuffer());
        this.total = data.length;
        this.count(data.length);
        this.insert(0, data);
        return;
      }
      if (res.status !== 206) throw new Error(`HTTP ${res.status} for ${this.url}`);
      const cr = res.headers.get("Content-Range");
      const m = cr && /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(cr);
      if (!m) throw new Error("206 response without a readable Content-Range (is it exposed via CORS?)");
      if (m[3] !== "*") this.total = Number(m[3]);
      const data = new Uint8Array(await res.arrayBuffer());
      this.count(data.length);
      this.insert(Number(m[1]), data);
    } finally {
      this.release();
    }
  }

  private count(bytes: number) {
    this.stats.requests++;
    this.stats.bytes += bytes;
    this.onRequest?.(this.stats);
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => (this.active++, resolve())));
  }

  private release() {
    this.active--;
    this.queue.shift()?.();
  }

  /** Index of the last span starting at or before `pos` (or 0). */
  private findSpan(pos: number): number {
    let lo = 0;
    let hi = this.spans.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.spans[mid].start <= pos) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Uncached sub-ranges of `[s, e)`. */
  private gaps(s: number, e: number): ByteRange[] {
    const out: ByteRange[] = [];
    let at = s;
    for (let i = this.findSpan(s); i < this.spans.length && at < e; i++) {
      const sp = this.spans[i];
      if (sp.end <= at) continue;
      if (sp.start >= e) break;
      if (sp.start > at) out.push([at, sp.start]);
      at = Math.max(at, sp.end);
    }
    if (at < e) out.push([at, e]);
    return out;
  }

  private insert(start: number, data: Uint8Array) {
    const end = start + data.length;
    // Keep only the parts not already cached so spans never overlap.
    for (const [a, b] of this.gaps(start, end)) {
      const span = { start: a, end: b, data: data.subarray(a - start, b - start), used: ++this.clock };
      const i = this.spans.findIndex((x) => x.start > a);
      this.spans.splice(i < 0 ? this.spans.length : i, 0, span);
      this.cached += b - a;
    }
    this.evict();
  }

  private evict() {
    if (this.cached <= this.cacheBytes) return;
    const byAge = [...this.spans].sort((a, b) => a.used - b.used);
    const drop = new Set<Span>();
    for (const s of byAge) {
      if (this.cached <= this.cacheBytes * 0.8) break;
      drop.add(s);
      this.cached -= s.end - s.start;
    }
    this.spans = this.spans.filter((s) => !drop.has(s));
  }
}

