# IIIF Presentation integration

IIIF Presentation 3 doesn't require an Image API service: a painting
annotation's `body` can point straight at a file. So a range-readable JP2 fits
in the current specs with no changes. What has to change is the viewers, which
must recognise such a body and read it by byte range instead of loading the
whole file.

## Manifest shape

[iiif-manifest-example.json](iiif-manifest-example.json) is what the viewer
generates for a stacks file (the **IIIF manifest** button shows it for whatever
is open). The body is the JP2 itself, with two services:

- **`RangeJP2`** (`https://github.com/jcoyne/cloud-tiles/ns/RangeJP2`), a
  custom service saying the file can be read by range: the profile ends in
  `/tlm` or `/plt`, depending on which index the file carries. Not every JP2
  qualifies. The extra fields (`indexBytes`, `fileSize`, `tileSize`, `levels`,
  `layers`) are hints a client could use to plan requests before reading the
  header. The viewer doesn't use them yet.
- **`ImageService2`**, the existing stacks image server, so viewers that only
  speak the Image API keep working. They ignore the service type they don't
  recognise.

`service` allows any `type`, so this is valid Presentation 3. If the idea
spreads, the proper route is to register it as a IIIF extension (registry entry
plus a JSON-LD context) rather than change the core specs.

## Manifest mode in the viewer

Open `?manifest=<url>`, or paste a URL ending in `.json` or containing
`manifest` into the URL field. For each canvas the viewer picks, in order:

1. Byte ranges, if the body has a `RangeJP2` service, or a JP2-family `format`
   (`image/jp2`, `image/jph`, `image/j2c`, `image/jphc`, `image/jpx`), or an
   Image API service on stacks.stanford.edu. The last case maps to the stacks
   file (`/image/iiif/{druid}%2F{name}` → `/file/{druid}/{name}.jp2`), so
   existing PURL manifests work unchanged.
2. The IIIF Image API (2 or 3), also used when step 1 fails, e.g. a file
   without TLM or PLT.
3. The body as a plain image.

The HUD shows which path was taken and why. `&canvas=N` selects a canvas, and
manifests with more than one canvas get a canvas menu.
[`web/public/manifests/example.json`](../web/public/manifests/example.json)
exercises the four range cases (it uses relative ids so it works on the dev
server). The prototype only reads Presentation 3 and ignores Collections,
ranges and non-painting annotations.

## What the Image API still provides

Byte ranges replace deep zoom, the expensive part of an image server. They
don't replace URL-addressable derivatives:

- thumbnails (search results, grids, the manifest's `thumbnail`)
- regions for annotations, exhibits and Content Search highlights
- clients that can't run the WASM decoder (PDF generation, ML pipelines,
  harvesters)

Two ways to cover those: pre-generate a few static derivatives, or run the same
decoder at the edge (a Worker or Lambda) as a small level-0/1 Image API over
the same range reads.

## Auth

IIIF Auth 2.0 probe services attach to any content resource, so they can guard
the raw JP2. Credentialed range requests need `Access-Control-Allow-Credentials`
and a specific origin rather than `*`.
