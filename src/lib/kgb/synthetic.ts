import { gbaHeaderChecksum, GBA_LOGO_16 } from "./gba.ts";
import { encodeRgb565Icon, SMDH_SIZE, writeUtf16 } from "./smdh.ts";

export const SYNTH_ROM_SIZE = 0x400;
export const SYNTH_PREAMBLE = 0x2000;
export const SYNTH_SAVE = 0x04;
export const SYNTH_GHOST = 0x10;
export const SYNTH_SLEEP = 0x00fe;

const BRASS = [0xd6, 0xb2, 0x5e, 255] as const;
const INK = [0x1a, 0x1c, 0x14, 255] as const;
const STAMP = [0xc4, 0x45, 0x36, 255] as const;
const PAPER = [0xe6, 0xe1, 0xd3, 255] as const;

/** 48×48 dossier seal. Shared with kgb.py — keep the geometry in lockstep. */
export function syntheticIconRgba(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(48 * 48 * 4);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const border = x < 2 || y < 2 || x >= 46 || y >= 46;
      const inner = x >= 4 && x < 44 && y >= 4 && y < 44 && (x < 6 || y < 6 || x >= 42 || y >= 42);
      const bar = y >= 20 && y < 28 && x >= 8 && x < 40 && ((x >= 8 && x < 14) || (x >= 18 && x < 24) || (x >= 28 && x < 40));
      const mark = !bar && y >= 16 && y < 32 && x >= 6 && x < 42;
      let px: readonly [number, number, number, number] = INK;
      if (border || inner) px = BRASS;
      else if (bar) px = PAPER;
      else if (mark) px = STAMP;
      const i = (y * 48 + x) * 4;
      rgba[i] = px[0];
      rgba[i + 1] = px[1];
      rgba[i + 2] = px[2];
      rgba[i + 3] = px[3];
    }
  }
  return rgba;
}

function putU32(buf: Uint8Array, off: number, value: number) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >>> 8) & 0xff;
  buf[off + 2] = (value >>> 16) & 0xff;
  buf[off + 3] = (value >>> 24) & 0xff;
}

function putU16(buf: Uint8Array, off: number, value: number) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >>> 8) & 0xff;
}

function putAscii(buf: Uint8Array, off: number, text: string) {
  for (let i = 0; i < text.length; i++) buf[off + i] = text.charCodeAt(i) & 0xff;
}

export function buildSyntheticRom(): Uint8Array {
  const rom = new Uint8Array(SYNTH_ROM_SIZE);
  rom.set(GBA_LOGO_16, 0x04);
  putAscii(rom, 0xa0, "KGB DOSSIER ");
  putAscii(rom, 0xac, "KGBE");
  putAscii(rom, 0xb0, "K1");
  rom[0xb2] = 0x96;
  rom[0xbd] = gbaHeaderChecksum(rom);
  for (let i = 0x100; i < 0x3f0; i++) rom[i] = (i * 17 + 3) & 0xff;
  rom.fill(0xff, 0x3f0);
  return rom;
}

function buildLut(): Uint8Array {
  const lut = new Uint8Array(0x300);
  for (let i = 0; i < 256; i++) {
    lut[i * 3] = Math.floor((i * 200) / 255);
    lut[i * 3 + 1] = Math.floor((i * 180) / 255);
    lut[i * 3 + 2] = Math.floor((i * 140) / 255);
  }
  return lut;
}

export function buildCaaFooter(romSize: number, codeBeforeFooter: number): Uint8Array {
  const footer = new Uint8Array(0x360);
  putU32(footer, 0x04, romSize);
  putU32(footer, 0x08, SYNTH_SAVE);
  putU16(footer, 0x0c, 0xffff);
  putU16(footer, 0x0e, SYNTH_SLEEP);
  footer.set(buildLut(), 0x24);
  putU32(footer, 0x20, SYNTH_GHOST);
  putU32(footer, 0x330, 0);
  putU32(footer, 0x334, 0);
  putU32(footer, 0x338, romSize);
  putU32(footer, 0x340, 1);
  putU32(footer, 0x344, codeBeforeFooter);
  putU32(footer, 0x348, 0x324);
  putAscii(footer, 0x350, ".CAA");
  putU32(footer, 0x354, 1);
  putU32(footer, 0x358, codeBeforeFooter + 0x330);
  putU32(footer, 0x35c, 2 << 4);
  return footer;
}

function buildSmdh(): Uint8Array {
  const smdh = new Uint8Array(SMDH_SIZE);
  putAscii(smdh, 0, "SMDH");
  for (const idx of [0, 1]) {
    const base = 0x8 + idx * 0x200;
    writeUtf16(smdh, base, 0x80, "KGB TEST");
    writeUtf16(smdh, base + 0x80, 0x100, "Kernel GBA Boy");
    writeUtf16(smdh, base + 0x180, 0x80, "KGB ARCHIVES");
  }
  const icon = encodeRgb565Icon(syntheticIconRgba(), 48);
  smdh.set(icon, 0x24c0);
  return smdh;
}

function align64(n: number): number {
  return (n + 0x3f) & ~0x3f;
}

function alignUp(n: number, a: number): number {
  return (n + (a - 1)) & ~(a - 1);
}

/** Spec-compliant synthetic GBA VC CIA: 0x2000 preamble, valid header, .CAA, SMDH. */
export function buildSyntheticCia(): Uint8Array {
  const rom = buildSyntheticRom();
  const preamble = new Uint8Array(SYNTH_PREAMBLE);
  putAscii(preamble, 0, "AGB_FIRM BOOT");
  const codeBefore = preamble.length + rom.length;
  const footer = buildCaaFooter(rom.length, codeBefore);
  const code = new Uint8Array(codeBefore + footer.length);
  code.set(preamble, 0);
  code.set(rom, preamble.length);
  code.set(footer, codeBefore);

  const smdh = buildSmdh();
  const codeAligned = alignUp(code.length, 0x200);
  const exefsBody = codeAligned + smdh.length;
  const exefsTotal = alignUp(0x200 + exefsBody, 0x200);

  const exheader = new Uint8Array(0x800);
  putAscii(exheader, 0, "KgbApp");
  const ncchHead = 0x200;
  const exefsMedia = (ncchHead + exheader.length) / 0x200;
  const ncchSize = ncchHead + exheader.length + exefsTotal;

  const headerSize = 0x2020;
  const certSize = 0x40;
  const ticketSize = 0x40;
  const tmdSize = 0x40;
  const ncchOff = align64(headerSize) + align64(certSize) + align64(ticketSize) + align64(tmdSize);
  const fileSize = ncchOff + ncchSize;
  const file = new Uint8Array(fileSize);

  putU32(file, 0x00, headerSize);
  putU32(file, 0x08, certSize);
  putU32(file, 0x0c, ticketSize);
  putU32(file, 0x10, tmdSize);
  putU32(file, 0x14, 0);
  putU32(file, 0x18, ncchSize);
  file[0x20] = 0x80;

  putAscii(file, align64(headerSize), "CERT");
  putAscii(file, align64(headerSize) + align64(certSize), "TICK");
  putAscii(file, align64(headerSize) + align64(certSize) + align64(ticketSize), "TMD!");

  const ncch = ncchOff;
  putAscii(file, ncch + 0x100, "NCCH");
  putU32(file, ncch + 0x104, ncchSize / 0x200);
  putU32(file, ncch + 0x108, 0x004b4742);
  putU32(file, ncch + 0x10c, 0x0004800f);
  putAscii(file, ncch + 0x110, "01");
  putU32(file, ncch + 0x118, 0x004b4742);
  putU32(file, ncch + 0x11c, 0x0004800f);
  putAscii(file, ncch + 0x150, "CTR-P-KGBE");
  putU32(file, ncch + 0x180, 0x400);
  file[ncch + 0x18d] = 0x02;
  file[ncch + 0x18f] = 0x04;
  putU32(file, ncch + 0x1a0, exefsMedia);
  putU32(file, ncch + 0x1a4, exefsTotal / 0x200);
  putU32(file, ncch + 0x1a8, 1);

  file.set(exheader, ncch + ncchHead);

  const exefs = ncch + ncchHead + exheader.length;
  putAscii(file, exefs, ".code");
  putU32(file, exefs + 8, 0);
  putU32(file, exefs + 12, code.length);
  putAscii(file, exefs + 16, "icon");
  putU32(file, exefs + 16 + 8, codeAligned);
  putU32(file, exefs + 16 + 12, smdh.length);
  file.set(code, exefs + 0x200);
  file.set(smdh, exefs + 0x200 + codeAligned);
  return file;
}
