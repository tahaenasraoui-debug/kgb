import { assetUrl } from "../download.ts";

let cachedGoomba: Uint8Array | null = null;

export async function loadGoombaBase(): Promise<Uint8Array> {
  if (cachedGoomba) return cachedGoomba;
  const res = await fetch(assetUrl("goomba.gba"));
  if (!res.ok) {
    throw new Error(`Failed to load Goomba Color runner: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  cachedGoomba = new Uint8Array(buf);
  return cachedGoomba;
}

export function setCachedGoomba(bytes: Uint8Array): void {
  cachedGoomba = bytes;
}

/**
 * Packages a Game Boy or Game Boy Color ROM with the Goomba Color GBA runner.
 * Resulting .gba boots directly into the GB/GBC game on GBA hardware and emulators.
 */
export function buildGoombaGba(goombaBase: Uint8Array, gbRom: Uint8Array, title?: string): Uint8Array {
  const runner = new Uint8Array(goombaBase);

  // If a title is provided, patch it into the GBA header at 0xA0..0xAB
  if (title) {
    const clean = title.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    for (let i = 0; i < 12; i++) {
      runner[0xa0 + i] = i < clean.length ? clean.charCodeAt(i) : 0;
    }
    // Recompute complement check byte at 0xBD
    let chk = 0;
    for (let i = 0xa0; i <= 0xbc; i++) {
      chk = (chk - (runner[i] ?? 0)) & 0xff;
    }
    runner[0xbd] = (chk - 0x19) & 0xff;
  }

  // Concatenate Goomba runner + Game Boy ROM
  const combined = new Uint8Array(runner.length + gbRom.length);
  combined.set(runner, 0);
  combined.set(gbRom, runner.length);
  return combined;
}
