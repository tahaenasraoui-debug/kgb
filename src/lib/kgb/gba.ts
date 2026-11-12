import { asciiField, describeSave } from "./format.ts";
import type { CaaFooter, GbaHeader } from "./types.ts";

/** First 16 bytes of the mandatory GBA Nintendo logo at header+0x04. */
export const GBA_LOGO_16 = Uint8Array.of(
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
);

export function gbaHeaderChecksum(header: Uint8Array): number {
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - (header[i] ?? 0)) & 0xff;
  return (chk - 0x19) & 0xff;
}

function logoAt(code: Uint8Array, off: number): boolean {
  if (off + 0xbe > code.length) return false;
  for (let i = 0; i < GBA_LOGO_16.length; i++) {
    if (code[off + 0x04 + i] !== GBA_LOGO_16[i]) return false;
  }
  if (code[off + 0xb2] !== 0x96) return false;
  const expect = gbaHeaderChecksum(code.subarray(off, off + 0xc0));
  return code[off + 0xbd] === expect;
}

/** Scan 0x00, 0x2000, then every 4-byte aligned offset for a real GBA header. */
export function findRomStart(code: Uint8Array): number | null {
  const tryAt = (off: number) => (off >= 0 && logoAt(code, off) ? off : null);
  const first = tryAt(0);
  if (first !== null) return first;
  const pre = tryAt(0x2000);
  if (pre !== null) return pre;
  const limit = code.length - 0xbe;
  for (let off = 4; off <= limit; off += 4) {
    if (off === 0x2000) continue;
    if (code[off + 0x04] !== 0x24) continue;
    if (logoAt(code, off)) return off;
  }
  return null;
}

function u32(code: Uint8Array, off: number): number {
  return (
    (code[off]! |
      (code[off + 1]! << 8) |
      (code[off + 2]! << 16) |
      (code[off + 3]! << 24)) >>>
    0
  );
}

export type FooterHit = { start: number; trustedMagic: boolean };

/**
 * The 0x360-byte AGB_FIRM footer ends with `.CAA` at +0x350 (0x10 bytes before
 * the end of the structure). Prefer a hit whose version word is 1 and whose
 * rom_size looks like a cartridge.
 */
export function findCaaFooter(code: Uint8Array): FooterHit | null {
  let fallback: FooterHit | null = null;
  const min = 0x350;
  for (let i = code.length - 4; i >= min; i--) {
    if (code[i] !== 0x2e || code[i + 1] !== 0x43 || code[i + 2] !== 0x41 || code[i + 3] !== 0x41) {
      continue;
    }
    const start = i - 0x350;
    if (start + 0x360 > code.length) continue;
    const romSize = u32(code, start + 0x04);
    const version = u32(code, start + 0x354);
    const nearEnd = code.length - (start + 0x360) <= 0x1000;
    const sane = romSize >= 0xc0 && romSize <= start;
    if (version === 1 && sane && nearEnd) return { start, trustedMagic: true };
    if (!fallback && sane) fallback = { start, trustedMagic: true };
  }
  if (fallback) return fallback;
  if (code.length >= 0x360) return { start: code.length - 0x360, trustedMagic: false };
  return null;
}

export function readGbaHeader(rom: Uint8Array): GbaHeader {
  const logoOk =
    rom.length >= 0x14 && GBA_LOGO_16.every((b, i) => rom[0x04 + i] === b);
  const checksum = rom.length >= 0xbe ? gbaHeaderChecksum(rom) : 0;
  return {
    title: rom.length >= 0xac ? asciiField(rom, 0xa0, 12) : "",
    gameCode: rom.length >= 0xb0 ? asciiField(rom, 0xac, 4) : "",
    maker: rom.length >= 0xb2 ? asciiField(rom, 0xb0, 2) : "",
    version: rom.length > 0xbc ? rom[0xbc]! : 0,
    checksum,
    checksumOk: rom.length > 0xbd && rom[0xbd] === checksum && rom[0xb2] === 0x96,
    logoOk,
  };
}

export function readCaa(code: Uint8Array, start: number, trustedMagic: boolean): CaaFooter {
  const footer = code.slice(start, start + 0x360);
  const romSize = u32(footer, 0x04);
  const saveId = u32(footer, 0x08);
  const sleepCombo = footer[0x0e]! | (footer[0x0f]! << 8);
  const ghost = u32(footer, 0x20);
  const lut = footer.slice(0x24, 0x24 + 0x300);
  const flash = footer.slice(0x10, 0x20);
  const flashHex = Array.from(flash, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
  return {
    romSize,
    save: describeSave(saveId),
    lcdGhosting: ghost,
    sleepCombo,
    flashConfigHex: flashHex,
    videoLut: lut,
    version: u32(footer, 0x354),
    descriptorOffset: u32(footer, 0x358),
    descriptorCountShifted: u32(footer, 0x35c),
    magicOk: trustedMagic && footer[0x350] === 0x2e && footer[0x351] === 0x43 && footer[0x352] === 0x41 && footer[0x353] === 0x41,
    footer,
  };
}
