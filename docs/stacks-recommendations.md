# Stacks: HTTP/CORS recommendations for range-request viewing

The viewer already works against `stacks.stanford.edu` **with no changes**: it
sends one plain `Range: bytes=a-b` header per request, which is CORS-safelisted,
so no preflight happens. The changes below make it more robust, cacheable and
measurable. They're in priority order.

## What Stacks sends today

Observed on 2026-10-17 for
`/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2`:

```
GET with Range: bytes=0-99, Origin: http://localhost:5173
HTTP/2 206
access-control-allow-origin: *
access-control-expose-headers: Content-Range
accept-ranges: bytes
cache-control: max-age=600, private
etag: W/"b924dc9fa717c6672d3ca3650bd28f4b"
last-modified: Tue, 16 May 2017 14:26:32 GMT
content-range: bytes 0-99/4541049
x-runtime: 0.028018            ← response produced by the Rails app

OPTIONS preflight
access-control-allow-headers: Range
access-control-allow-methods: GET, OPTIONS
access-control-max-age: 86400
```

Already good: HTTP/2 (so many small requests are cheap), `Accept-Ranges`,
correct `206` + `Content-Range`, `Content-Range` exposed to JS, a long preflight
max-age, and `Range` allowed in preflights.

## Recommendations

### 1. Expose `ETag` (and `Accept-Ranges`, `Content-Length`) to JavaScript

```
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag
```

A viewer stitches one image together from many separate range responses. If
the file is replaced while someone is viewing it, the pieces come from two
different files and the decode is garbage or fails. The client checks the
`ETag` on every response for this, but cross-origin JS can only read it if it
is exposed. (`Content-Length` and `Last-Modified` are already readable, but
listing them does no harm.)

### 2. Use a strong ETag on file responses

`W/"…"` is a weak validator, and HTTP (RFC 9110 §13.1.5) does not allow weak
validators with `If-Range`. A strong ETag, such as a content digest the
preservation system already has (md5/sha), lets clients:
- send `If-Range` safely, and get back the full new file rather than a range of
  a changed file, and
- revalidate cached ranges with `If-None-Match`.

Rails makes weak ETags by default. Setting a strong one explicitly (for
example from the file's stored checksum) fixes this.

### 3. Allow `If-Range` in preflights (optional)

```
Access-Control-Allow-Headers: Range, If-Range
```

This only matters together with #2. `If-Range` is not safelisted, so sending it
triggers a preflight; with `Access-Control-Max-Age: 86400` that's one OPTIONS
per origin per day, which is cheap.

### 4. Make immutable file content publicly cacheable

`cache-control: max-age=600, private` keeps responses out of shared caches
(CDNs, proxies). If a given `/file/<druid>/<name>` can change between versions,
something like this works:

```
Cache-Control: public, max-age=3600, stale-while-revalidate=86400
```

If version-specific URLs exist (or are added), use
`public, max-age=31536000, immutable` on those. Note that `Vary: Origin` is
not needed while `Access-Control-Allow-Origin` stays `*`.

This is optional for access-controlled files (Stanford-only, embargoed), which
should stay `private`.

### 5. Add `Timing-Allow-Origin`

```
Timing-Allow-Origin: *
```

Without it, the browser's Resource Timing API zeroes `transferSize`,
connection and TTFB details for cross-origin requests. We need those numbers
for the benchmark (Phase 8), and they're useful for any viewer telemetry.

### 6. Serve ranges without going through Rails (performance)

`x-runtime` and `status:` headers mean the app handles each request. With
range viewing, one zoom gesture is dozens to hundreds of small requests. Letting
the app authorize and then handing the byte serving to the web server keeps
per-request latency down:
- Apache: `mod_xsendfile` (`X-Sendfile`), with Rails `config.action_dispatch.x_sendfile_header = "X-Sendfile"`
- or serving public files straight from Apache/an object store/CDN.

Check after the change that 206 responses still carry the CORS headers above,
and that `Range` with a suffix (`bytes=-1024`) and open-ended (`bytes=1000-`)
forms work.

### 7. Not needed

- **Multipart ranges** (`Range: bytes=0-9,100-199`): the client deliberately
  makes one range per request and merges nearby ranges itself.
- **`Access-Control-Allow-Credentials`**: only needed if Stanford-only files
  should be viewable this way (cookies). That would also require a specific
  `Access-Control-Allow-Origin` (not `*`) plus `Vary: Origin`.

## Minimal Apache sketch

```apache
<LocationMatch "^/file/">
  Header always set Access-Control-Allow-Origin "*"
  Header always set Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges, ETag"
  Header always set Access-Control-Allow-Headers "Range, If-Range"
  Header always set Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
  Header always set Access-Control-Max-Age "86400"
  Header always set Timing-Allow-Origin "*"
</LocationMatch>
```
