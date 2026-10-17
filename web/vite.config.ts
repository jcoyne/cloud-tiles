import { createReadStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const testdata = resolve(import.meta.dirname, "../testdata");

/**
 * Serve ../testdata at /testdata/ with single-range support, so the viewer
 * can be exercised locally exactly as it would against object storage.
 */
function rangeServer(): Plugin {
  return {
    name: "testdata-range-server",
    configureServer(server) {
      server.middlewares.use("/testdata/", (req, res, next) => {
        const path = resolve(testdata, decodeURIComponent((req.url ?? "/").split("?")[0].slice(1)));
        if (!path.startsWith(testdata + sep)) return next();
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          return next();
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
        res.setHeader("Content-Type", "application/octet-stream");
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (!m) {
          res.setHeader("Content-Length", size);
          if (req.method === "HEAD") return res.end();
          return createReadStream(path).pipe(res);
        }
        let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
        let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        start = Math.max(0, start);
        if (start > end) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${size}`);
          return res.end();
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        res.setHeader("Content-Length", end - start + 1);
        if (req.method === "HEAD") return res.end();
        createReadStream(path, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [rangeServer()],
  worker: { format: "es" },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
