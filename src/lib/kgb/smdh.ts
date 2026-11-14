import { utf16le } from "./format.ts";
import type { SmdhTitles } from "./types.ts";

const LANGS = [
  "Japanese",
  "English",
  "French",
  "German",
  "Italian",
  "Spanish",
  "Simplified Chinese",
  "Korean",
  "Dutch",
  "Portuguese",
  "Russian",
  "Traditional Chinese",
] as const;

export const SMDH_SIZE = 0x36c0;
export const LARGE_ICON_OFFSET = 0x24c0;
export const LARGE_ICON_BYTES = 0x1200;

/** Even bits → x, odd bits → y. Matches the 8×8 Morton order used by SMDH icons. */
export function morton8(i: number): { x: number; y: number } {
  const x = (i & 1) | ((i & 4) >> 1) | ((i & 16) >> 2);
  const y = ((i & 2) >> 1) | ((i & 8) >> 2) | ((i & 32) >> 3);
  return { x, y };
}

export function decodeRgb565Icon(src: Uint8Array, size = 48): Uint8ClampedArray {
  const pixels = size * size;
  if (src.length < pixels * 2) throw new Error(`Icon is ${src.length} bytes, need ${pixels * 2}.`);
  const rgba = new Uint8ClampedArray(pixels * 4);
  const tiles = size / 8;
  let o = 0;
  for (let tile = 0; tile < tiles * tiles; tile++) {
    const tileX = tile % tiles;
    const tileY = Math.floor(tile / tiles);
    for (let p = 0; p < 64; p++) {
      const { x, y } = morton8(p);
      const dx = tileX * 8 + x;
      const dy = tileY * 8 + y;
      const pix = src[o]! | (src[o + 1]! << 8);
      o += 2;
      const r = Math.round(((pix >> 11) & 0x1f) * (255 / 31));
      const g = Math.round(((pix >> 5) & 0x3f) * (255 / 63));
      const b = Math.round((pix & 0x1f) * (255 / 31));
      const di = (dy * size + dx) * 4;
      rgba[di] = r;
      rgba[di + 1] = g;
      rgba[di + 2] = b;
      rgba[di + 3] = 255;
    }
  }
  return rgba;
}

export function encodeRgb565Icon(rgba: Uint8ClampedArray, size = 48): Uint8Array {
  const out = new Uint8Array(size * size * 2);
  const tiles = size / 8;
  let o = 0;
  for (let tile = 0; tile < tiles * tiles; tile++) {
    const tileX = tile % tiles;
    const tileY = Math.floor(tile / tiles);
    for (let p = 0; p < 64; p++) {
      const { x, y } = morton8(p);
      const di = ((tileY * 8 + y) * size + (tileX * 8 + x)) * 4;
      const r = rgba[di] ?? 0;
      const g = rgba[di + 1] ?? 0;
      const b = rgba[di + 2] ?? 0;
      const pix = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      out[o] = pix & 0xff;
      out[o + 1] = (pix >> 8) & 0xff;
      o += 2;
    }
  }
  return out;
}

function readBlock(data: Uint8Array, base: number): { short: string; long: string; publisher: string } {
  return {
    short: utf16le(data, base, 0x80),
    long: utf16le(data, base + 0x80, 0x100),
    publisher: utf16le(data, base + 0x180, 0x80),
  };
}

export function parseSmdh(data: Uint8Array): { titles: SmdhTitles; icon: Uint8ClampedArray | null } | null {
  if (data.length < 4) return null;
  if (data[0] !== 0x53 || data[1] !== 0x4d || data[2] !== 0x44 || data[3] !== 0x48) return null;
  let chosen: SmdhTitles | null = null;
  // English, then Japanese, then the first block that has any text.
  const order = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  for (const idx of order) {
    const base = 0x8 + idx * 0x200;
    if (base + 0x200 > data.length) break;
    const block = readBlock(data, base);
    if (block.short || block.long || block.publisher) {
      chosen = { language: LANGS[idx] ?? `Language ${idx}`, ...block };
      break;
    }
  }
  if (!chosen) {
    chosen = { language: "—", short: "", long: "", publisher: "" };
  }
  let icon: Uint8ClampedArray | null = null;
  if (data.length >= LARGE_ICON_OFFSET + LARGE_ICON_BYTES) {
    icon = decodeRgb565Icon(data.subarray(LARGE_ICON_OFFSET, LARGE_ICON_OFFSET + LARGE_ICON_BYTES), 48);
  }
  return { titles: chosen, icon };
}

export function writeUtf16(target: Uint8Array, offset: number, byteLen: number, text: string) {
  const maxChars = byteLen / 2;
  for (let i = 0; i < maxChars; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 0;
    target[offset + i * 2] = c & 0xff;
    target[offset + i * 2 + 1] = (c >> 8) & 0xff;
  }
}
