import { glyphRows5x7 } from "./font5x7.ts";
import type { CarrierLabel } from "./types.ts";

export type { CarrierLabel };

export const SCREEN_W = 256;
export const SCREEN_H = 192;
export const FRAME_BYTES = SCREEN_W * SCREEN_H * 2;

export const INK = rgb555(0x0e, 0x0f, 0x0c);
export const PAPER = rgb555(0xe6, 0xe1, 0xd3);
export const BRASS = rgb555(0xd6, 0xb2, 0x5e);
export const STAMP = rgb555(0xc4, 0x45, 0x36);
export const DUST = rgb555(0x8d, 0x88, 0x78);
export const PANEL = rgb555(0x17, 0x19, 0x10);

export function rgb555(r: number, g: number, b: number): number {
  return ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);
}

export function expand555(color: number): [number, number, number] {
  const r = Math.round(((color & 31) * 255) / 31);
  const g = Math.round((((color >> 5) & 31) * 255) / 31);
  const b = Math.round((((color >> 10) & 31) * 255) / 31);
  return [r, g, b];
}

export function blankScreen(color = INK): Uint8Array {
  const buf = new Uint8Array(FRAME_BYTES);
  const lo = color & 0xff;
  const hi = color >> 8;
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    buf[i] = lo;
    buf[i + 1] = hi;
  }
  return buf;
}

export function putPixel(buf: Uint8Array, x: number, y: number, color: number) {
  if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
  const o = (y * SCREEN_W + x) * 2;
  buf[o] = color & 0xff;
  buf[o + 1] = color >> 8;
}

export function fillRect(buf: Uint8Array, x: number, y: number, w: number, h: number, color: number) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) putPixel(buf, x + xx, y + yy, color);
  }
}

function glyphRows(ch: string): number[] {
  return glyphRows5x7(ch);
}

export function drawText(
  buf: Uint8Array,
  text: string,
  x: number,
  y: number,
  color: number,
  scale = 1,
): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = glyphRows(ch);
    for (let row = 0; row < 7; row++) {
      const bits = rows[row] ?? 0;
      for (let col = 0; col < 5; col++) {
        if (((bits >> (4 - col)) & 1) === 0) continue;
        fillRect(buf, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

export function textWidth(text: string, scale = 1): number {
  if (text.length === 0) return 0;
  return text.length * 6 * scale - scale;
}

export function wrapText(text: string, cols: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const chunk = word.length > cols ? word.slice(0, cols) : word;
    const next = cur ? `${cur} ${chunk}` : chunk;
    if (next.length <= cols) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = chunk;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function drawLines(
  buf: Uint8Array,
  lines: string[],
  x: number,
  y: number,
  color: number,
  scale = 1,
  leading = 8,
): number {
  let cy = y;
  for (const line of lines) {
    drawText(buf, line, x, cy, color, scale);
    cy += leading * scale;
  }
  return cy;
}

export function blitRgba(
  buf: Uint8Array,
  rgba: Uint8ClampedArray,
  size: number,
  x: number,
  y: number,
  scale = 1,
) {
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      const a = rgba[i + 3] ?? 255;
      if (a < 16) continue;
      const color = rgb555(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
      fillRect(buf, x + px * scale, y + py * scale, scale, scale, color);
    }
  }
}

export function renderCarrierScreens(label: CarrierLabel): { top: Uint8Array; bottom: Uint8Array } {
  const sky = rgb555(0x6e, 0xbc, 0xf2);
  const frame = rgb555(0x3d, 0x62, 0xb8);
  const top = blankScreen(sky);
  const bottom = blankScreen(PAPER);
  fillRect(top, 0, 0, SCREEN_W, 6, frame);
  fillRect(top, 0, SCREEN_H - 6, SCREEN_W, 6, frame);
  fillRect(top, 0, 0, 6, SCREEN_H, frame);
  fillRect(top, SCREEN_W - 6, 0, 6, SCREEN_H, frame);
  fillRect(top, 14, 16, SCREEN_W - 28, SCREEN_H - 32, PAPER);
  fillRect(top, 14, 16, SCREEN_W - 28, 8, STAMP);

  const title = (label.title || "UNTITLED").toUpperCase();
  let y = drawLines(top, wrapText(title, 11), 22, 36, INK, 2, 9);
  y += 6;
  drawText(top, label.gameCode || "----", 22, y, frame, 2);
  y += 22;
  drawText(top, `${label.bytes} BYTES`, 22, y, DUST, 1);
  drawText(top, label.checksumOk ? "HEADER OK" : "HEADER BAD", 22, y + 12, label.checksumOk ? frame : STAMP, 1);

  fillRect(bottom, 0, 0, SCREEN_W, 8, frame);
  drawText(bottom, "GBA ROM INSIDE", 12, 18, frame, 2);
  drawLines(
    bottom,
    wrapText("Saved as rom.gba. This screen is only a card. Extract the ROM to play.", 36),
    12,
    42,
    INK,
    1,
    9,
  );
  if (label.iconRgba && label.iconRgba.length >= 48 * 48 * 4) {
    blitRgba(bottom, label.iconRgba, 48, 196, 132, 1);
  }
  return { top, bottom };
}
