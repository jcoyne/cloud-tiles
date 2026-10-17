import type { Region } from "../jp2/image";

export interface DecodeRequest {
  id: number;
  codestream: Uint8Array;
  reduction: number;
  region: Region;
}

export type DecodeResponse =
  | { id: number; ok: true; width: number; height: number; bitmap?: ImageBitmap; rgba?: Uint8ClampedArray; ms: number }
  | { id: number; ok: false; error: string };
