import { crc16 } from "./crc16.ts";
import { readGbaHeader } from "./gba.ts";
import {
  BRASS,
  DUST,
  FRAME_BYTES,
  INK,
  PAPER,
  STAMP,
  expand555,
  renderCarrierScreens,
  rgb555,
  type CarrierLabel,
} from "./screen.ts";
import { KgbError, type GbaHeader } from "./types.ts";

/** 156-byte Nintendo logo required at NDS header 0xC0. CRC-16 must be 0xCF56. */
export const NDS_LOGO = Uint8Array.of(
  0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
  0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
  0x10, 0x46, 0x4a, 0x4a, 0xf8, 0x27, 0x31, 0xec, 0x58, 0xc7, 0xe8, 0x33, 0x82, 0xe3, 0xce, 0xbf,
  0x85, 0xf4, 0xdf, 0x94, 0xce, 0x4b, 0x09, 0xc1, 0x94, 0x56, 0x8a, 0xc0, 0x13, 0x72, 0xa7, 0xfc,
  0x9f, 0x84, 0x4d, 0x73, 0xa3, 0xca, 0x9a, 0x61, 0x58, 0x97, 0xa3, 0x27, 0xfc, 0x03, 0x98, 0x76,
  0x23, 0x1d, 0xc7, 0x61, 0x03, 0x04, 0xae, 0x56, 0xbf, 0x38, 0x84, 0x00, 0x40, 0xa7, 0x0e, 0xfd,
  0xff, 0x52, 0xfe, 0x03, 0x6f, 0x95, 0x30, 0xf1, 0x97, 0xfb, 0xc0, 0x85, 0x60, 0xd6, 0x80, 0x25,
  0xa9, 0x63, 0xbe, 0x03, 0x01, 0x4e, 0x38, 0xe2, 0xf9, 0xa2, 0x34, 0xff, 0xbb, 0x3e, 0x03, 0x44,
  0x78, 0x00, 0x90, 0xcb, 0x88, 0x11, 0x3a, 0x94, 0x65, 0xc0, 0x7c, 0x63, 0x87, 0xf0, 0x3c, 0xaf,
  0xd6, 0x25, 0xe4, 0x8b, 0x38, 0x0a, 0xac, 0x72, 0x21, 0xd4, 0xf8, 0x07,
);

export const CARRIER_README =
  "KGB NDS carrier\nThis is not a port. rom.gba is the original GBA image, byte for byte.\nBooting this file only shows the label. Extract rom.gba to play.\n";

const ARM9_RAM = 0x02000000;
const ARM7_RAM = 0x03800000;
const VRAM_A = 0x06800000;
const VRAM_C = 0x06840000;

export type NdsFile = { name: string; start: number; size: number };

export type EmbeddedGba = { name: string; rom: Uint8Array; header: GbaHeader };

export type NdsInfo = {
  fileName: string;
  fileSize: number;
  title: string;
  gameCode: string;
  maker: string;
  unitCode: number;
  romVersion: number;
  romSizeField: number;
  headerCrcOk: boolean;
  logoCrcOk: boolean;
  bannerTitle: string;
  bannerOffset: number;
  iconRgba: Uint8ClampedArray | null;
  files: NdsFile[];
  gba: EmbeddedGba | null;
  warnings: string[];
};

export type RgbaImage = { rgba: Uint8ClampedArray; width: number; height: number };

export type CarrierInput = {
  rom: Uint8Array;
  title?: string;
  gameCode?: string;
  maker?: string;
  version?: number;
  checksumOk?: boolean;
  /** Drawn on the bottom label screen. Does not change the menu icon by itself. */
  iconRgba?: Uint8ClampedArray | null;
  /**
   * Picture written into the banner the header points at (+0x68).
   * Omitted keeps the text seal (game code on a brass border).
   */
  bannerImage?: RgbaImage | null;
};

function u16(data: Uint8Array, off: number): number {
  return (data[off]! | (data[off + 1]! << 8)) & 0xffff;
}

function u32(data: Uint8Array, off: number): number {
  return (
    (data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16) | (data[off + 3]! << 24)) >>> 0
  );
}

function putU16(data: Uint8Array, off: number, value: number) {
  data[off] = value & 0xff;
  data[off + 1] = (value >> 8) & 0xff;
}

function putU32(data: Uint8Array, off: number, value: number) {
  data[off] = value & 0xff;
  data[off + 1] = (value >> 8) & 0xff;
  data[off + 2] = (value >> 16) & 0xff;
  data[off + 3] = (value >> 24) & 0xff;
}

function alignUp(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

function asciiFit(text: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const clean = text.replace(/[^\x20-\x7e]/g, " ");
  for (let i = 0; i < len && i < clean.length; i++) out[i] = clean.charCodeAt(i);
  return out;
}

function readAscii(data: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = data[off + i] ?? 0;
    if (c === 0) break;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
  }
  return s.trim();
}

export function isNdsRom(rom: Uint8Array): boolean {
  if (rom.length < 0x160) return false;
  for (let i = 0; i < NDS_LOGO.length; i++) {
    if (rom[0xc0 + i] !== NDS_LOGO[i]) return false;
  }
  return true;
}

export function looksLikeGba(rom: Uint8Array): boolean {
  const header = readGbaHeader(rom);
  return header.logoOk && header.checksumOk;
}

type ArmOp =
  | { op: "ldr"; rd: number; key: string }
  | { op: "mov"; rd: number; imm: number }
  | { op: "str"; rd: number; rn: number }
  | { op: "strb"; rd: number; rn: number }
  | { op: "strp"; rd: number; rn: number; imm: number }
  | { op: "ldrp"; rd: number; rn: number; imm: number }
  | { op: "subs"; rd: number; rn: number; imm: number }
  | { op: "b"; cond: number; target: string }
  | { op: "bl"; target: string }
  | { op: "bx"; rn: number }
  | { op: "label"; name: string };

function encodeArm(ops: ArmOp[], pool: Record<string, number>): { code: Uint8Array; labels: Record<string, number> } {
  const flat = ops.filter((op) => op.op !== "label");
  const labels: Record<string, number> = {};
  let pc = 0;
  for (const op of ops) {
    if (op.op === "label") labels[op.name] = pc;
    else pc += 4;
  }
  const poolKeys = Object.keys(pool);
  const words = new Uint8Array((flat.length + poolKeys.length) * 4);
  const view = new DataView(words.buffer);
  flat.forEach((op, index) => {
    const addr = index * 4;
    let word = 0;
    if (op.op === "ldr") {
      const slot = poolKeys.indexOf(op.key);
      const imm = flat.length * 4 + slot * 4 - (addr + 8);
      if (imm < 0 || imm > 0xfff) throw new Error(`Literal pool is out of reach (${imm}).`);
      word = 0xe59f0000 | (op.rd << 12) | (imm & 0xfff);
    } else if (op.op === "mov") {
      word = 0xe3a00000 | (op.rd << 12) | (op.imm & 0xff);
    } else if (op.op === "str") {
      word = 0xe5800000 | (op.rn << 16) | (op.rd << 12);
    } else if (op.op === "strb") {
      word = 0xe5c00000 | (op.rn << 16) | (op.rd << 12);
    } else if (op.op === "strp") {
      word = 0xe4a00000 | (op.rn << 16) | (op.rd << 12) | (op.imm & 0xfff);
    } else if (op.op === "ldrp") {
      word = 0xe4b00000 | (op.rn << 16) | (op.rd << 12) | (op.imm & 0xfff);
    } else if (op.op === "subs") {
      word = 0xe2500000 | (op.rn << 16) | (op.rd << 12) | (op.imm & 0xff);
    } else if (op.op === "b") {
      const target = labels[op.target] ?? 0;
      const off = ((target - addr - 8) >> 2) & 0xffffff;
      word = (op.cond << 28) | 0x0a000000 | off;
    } else if (op.op === "bl") {
      const target = labels[op.target] ?? 0;
      const off = ((target - addr - 8) >> 2) & 0xffffff;
      word = 0xeb000000 | off;
    } else if (op.op === "bx") {
      word = 0xe12fff10 | op.rn;
    }
    view.setUint32(addr, word, true);
  });
  poolKeys.forEach((key, index) => {
    view.setUint32((flat.length + index) * 4, pool[key]! >>> 0, true);
  });
  return { code: words, labels };
}

/** ARM9 image: stub that copies the two label framebuffers into VRAM, then the pixels. */
export function buildArm9Image(top: Uint8Array, bottom: Uint8Array): Uint8Array {
  const ops: ArmOp[] = [
    { op: "ldr", rd: 4, key: "powAddr" },
    { op: "ldr", rd: 0, key: "powVal" },
    { op: "str", rd: 0, rn: 4 },
    { op: "ldr", rd: 4, key: "vramA" },
    { op: "mov", rd: 0, imm: 0x80 },
    { op: "strb", rd: 0, rn: 4 },
    { op: "ldr", rd: 4, key: "vramC" },
    { op: "strb", rd: 0, rn: 4 },
    { op: "ldr", rd: 4, key: "disp" },
    { op: "ldr", rd: 0, key: "mode" },
    { op: "str", rd: 0, rn: 4 },
    { op: "ldr", rd: 4, key: "dispSub" },
    { op: "str", rd: 0, rn: 4 },
    { op: "ldr", rd: 0, key: "srcTop" },
    { op: "ldr", rd: 1, key: "dstTop" },
    { op: "ldr", rd: 2, key: "words" },
    { op: "bl", target: "copy" },
    { op: "ldr", rd: 0, key: "srcBot" },
    { op: "ldr", rd: 1, key: "dstBot" },
    { op: "ldr", rd: 2, key: "words" },
    { op: "bl", target: "copy" },
    { op: "label", name: "hang" },
    { op: "b", cond: 0xe, target: "hang" },
    { op: "label", name: "copy" },
    { op: "ldrp", rd: 3, rn: 0, imm: 4 },
    { op: "strp", rd: 3, rn: 1, imm: 4 },
    { op: "subs", rd: 2, rn: 2, imm: 1 },
    { op: "b", cond: 0x1, target: "copy" },
    { op: "bx", rn: 14 },
  ];
  const instrs = ops.filter((op) => op.op !== "label").length;
  const poolSlots = 12;
  const codeBytes = (instrs + poolSlots) * 4;
  const srcTop = ARM9_RAM + codeBytes;
  const pool = {
    powAddr: 0x04000304,
    powVal: 0x00000203,
    vramA: 0x04000240,
    vramC: 0x04000242,
    disp: 0x04000000,
    mode: 0x00020000,
    dispSub: 0x04001000,
    srcTop,
    dstTop: VRAM_A,
    words: FRAME_BYTES / 4,
    srcBot: srcTop + FRAME_BYTES,
    dstBot: VRAM_C,
  };
  const { code } = encodeArm(ops, pool);
  if (code.length !== codeBytes) throw new Error("ARM9 stub size drifted.");
  const image = new Uint8Array(codeBytes + FRAME_BYTES * 2);
  image.set(code, 0);
  image.set(top, codeBytes);
  image.set(bottom, codeBytes + FRAME_BYTES);
  return image;
}

/**
 * Run the carrier stub against a copy of the ARM9 image.
 * Returns the two VRAM framebuffers the DS would show.
 */
export function runArm9Blit(arm9: Uint8Array): { top: Uint8Array; bottom: Uint8Array } {
  const ram = new Uint8Array(arm9);
  const vram = new Uint8Array(0x80000);
  const regs = new Uint32Array(16);
  let z = false;
  let pc = 0;
  let steps = 0;
  const read32 = (addr: number): number => {
    let buf: Uint8Array;
    let off: number;
    if (addr >= ARM9_RAM && addr < ARM9_RAM + ram.length) {
      buf = ram;
      off = addr - ARM9_RAM;
    } else if (addr >= VRAM_A && addr < VRAM_A + vram.length) {
      buf = vram;
      off = addr - VRAM_A;
    } else return 0;
    return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
  };
  const write32 = (addr: number, value: number) => {
    let buf: Uint8Array | null = null;
    let off = 0;
    if (addr >= ARM9_RAM && addr < ARM9_RAM + ram.length) {
      buf = ram;
      off = addr - ARM9_RAM;
    } else if (addr >= VRAM_A && addr < VRAM_A + vram.length) {
      buf = vram;
      off = addr - VRAM_A;
    }
    if (!buf || off + 3 >= buf.length) return;
    buf[off] = value & 0xff;
    buf[off + 1] = (value >> 8) & 0xff;
    buf[off + 2] = (value >> 16) & 0xff;
    buf[off + 3] = (value >> 24) & 0xff;
  };
  while (steps++ < 500000) {
    const word = read32(ARM9_RAM + pc);
    if (word === 0xeafffffe) break;
    const rd = (word >> 12) & 0xf;
    const rn = (word >> 16) & 0xf;
    if ((word & 0x0f7f0000) === 0x051f0000) {
      const imm = word & 0xfff;
      const up = (word & 0x00800000) !== 0;
      const base = (pc + 8) >>> 0;
      const addr = (up ? base + imm : base - imm) >>> 0;
      regs[rd] = read32(ARM9_RAM + addr);
      pc += 4;
    } else if ((word & 0x0ff00000) === 0x03a00000) {
      regs[rd] = word & 0xff;
      pc += 4;
    } else if ((word & 0x0ff00fff) === 0x05800000) {
      write32(regs[rn]!, regs[rd]!);
      pc += 4;
    } else if ((word & 0x0ff00fff) === 0x05c00000) {
      pc += 4;
    } else if ((word & 0x0ff00000) === 0x04a00000) {
      write32(regs[rn]!, regs[rd]!);
      regs[rn] = (regs[rn]! + (word & 0xfff)) >>> 0;
      pc += 4;
    } else if ((word & 0x0ff00000) === 0x04b00000) {
      regs[rd] = read32(regs[rn]!);
      regs[rn] = (regs[rn]! + (word & 0xfff)) >>> 0;
      pc += 4;
    } else if ((word & 0x0ff00000) === 0x02500000) {
      const result = (regs[rn]! - (word & 0xff)) >>> 0;
      regs[rd] = result;
      z = result === 0;
      pc += 4;
    } else if ((word & 0x0e000000) === 0x0a000000) {
      const cond = word >>> 28;
      const link = (word & 0x01000000) !== 0;
      const take = cond === 0xe || (cond === 0x1 && !z) || (cond === 0x0 && z);
      const off = (word << 8) >> 8;
      const target = (pc + 8 + (off << 2)) >>> 0;
      if (link) regs[14] = (pc + 4) >>> 0;
      pc = take ? target : pc + 4;
    } else if ((word & 0x0ffffff0) === 0x012fff10) {
      pc = regs[word & 0xf]!;
    } else {
      throw new KgbError(`Stub hit an unexpected instruction at ${pc.toString(16)}.`);
    }
  }
  return { top: vram.slice(0, FRAME_BYTES), bottom: vram.slice(0x40000, 0x40000 + FRAME_BYTES) };
}

const ICON_PALETTE = [INK, BRASS, PAPER, STAMP, DUST, rgb555(0x17, 0x19, 0x10)];

function glyphBits(ch: string): number[] {
  const rows: Record<string, number[]> = {
    A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
    C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
    D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
    E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
    G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
    H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
    K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
    L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
    M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
    N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
    O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
    Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
    R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
    S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
    T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
    W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
    X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
    Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
    Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
    "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
    "4": [0b10010, 0b10010, 0b10010, 0b11111, 0b00010, 0b00010, 0b00010],
    "5": [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
    "6": [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  };
  return rows[ch] ?? [0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111];
}

function stampIcon(code: string): Uint8Array {
  const idx = new Uint8Array(32 * 32);
  for (let i = 0; i < 32; i++) {
    idx[i] = 1;
    idx[31 * 32 + i] = 1;
    idx[i * 32] = 1;
    idx[i * 32 + 31] = 1;
    idx[32 + i] = 3;
  }
  const paint = (text: string, x: number, y: number, color: number) => {
    let cx = x;
    for (const ch of text) {
      const rows = glyphBits(ch);
      for (let row = 0; row < 7; row++) {
        const bits = rows[row] ?? 0;
        for (let col = 0; col < 5; col++) {
          if (((bits >> (4 - col)) & 1) === 0) continue;
          const px = cx + col;
          const py = y + row;
          if (px > 0 && py > 0 && px < 31 && py < 31) idx[py * 32 + px] = color;
        }
      }
      cx += 6;
    }
  };
  paint("GBA", 7, 5, 2);
  const clean = (code || "----").toUpperCase().replace(/[^A-Z0-9]/g, "X").slice(0, 4).padEnd(4, "X");
  paint(clean, 4, 18, 1);
  return idx;
}

function encodeIcon(index: Uint8Array, colors: readonly number[]): { tiles: Uint8Array; palette: Uint8Array } {
  const tiles = new Uint8Array(512);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const tile = (ty * 4 + tx) * 32;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px += 2) {
          const c0 = index[(ty * 8 + py) * 32 + tx * 8 + px]! & 0xf;
          const c1 = index[(ty * 8 + py) * 32 + tx * 8 + px + 1]! & 0xf;
          tiles[tile + py * 4 + px / 2] = c0 | (c1 << 4);
        }
      }
    }
  }
  const palette = new Uint8Array(32);
  for (let i = 0; i < 16; i++) putU16(palette, i * 2, colors[i] ?? 0);
  return { tiles, palette };
}

export function decodeBannerIcon(banner: Uint8Array): Uint8ClampedArray | null {
  if (banner.length < 0x240) return null;
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  const pal: [number, number, number][] = [];
  for (let i = 0; i < 16; i++) pal.push(expand555(u16(banner, 0x220 + i * 2)));
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const tile = 0x20 + (ty * 4 + tx) * 32;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px += 2) {
          const byte = banner[tile + py * 4 + px / 2] ?? 0;
          const colors = [byte & 0xf, byte >> 4];
          for (let k = 0; k < 2; k++) {
            const [r, g, b] = pal[colors[k]!] ?? [0, 0, 0];
            const o = ((ty * 8 + py) * 32 + tx * 8 + px + k) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
          }
        }
      }
    }
  }
  return rgba;
}

function utf16Field(text: string): Uint8Array {
  const out = new Uint8Array(256);
  const chars = Array.from(text).slice(0, 128);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i]!.codePointAt(0) ?? 0x3f;
    const u = code > 0xffff ? 0x3f : code;
    out[i * 2] = u & 0xff;
    out[i * 2 + 1] = (u >> 8) & 0xff;
  }
  return out;
}

function readUtf16(data: Uint8Array, off: number): string {
  let s = "";
  for (let i = 0; i < 128; i++) {
    const c = u16(data, off + i * 2);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function buildBanner(title: string, code: string, icon?: { tiles: Uint8Array; palette: Uint8Array } | null): Uint8Array {
  const banner = new Uint8Array(0x840);
  putU16(banner, 0, 1);
  const drawn = icon ?? encodeIcon(stampIcon(code), ICON_PALETTE);
  banner.set(drawn.tiles, 0x20);
  banner.set(drawn.palette, 0x220);
  const line = `${title || "Untitled"} [${code || "----"}] GBA`.slice(0, 128);
  const field = utf16Field(line);
  for (let lang = 0; lang < 6; lang++) banner.set(field, 0x240 + lang * 256);
  putU16(banner, 2, crc16(banner, 0x20, 0x840));
  return banner;
}

type Pix = { r: number; g: number; b: number };

function channelOf(pixel: Pix, channel: number): number {
  return channel === 0 ? pixel.r : channel === 1 ? pixel.g : pixel.b;
}

/** Shrink any picture to the 32×32 the DS menu actually stores. */
function downsample32(rgba: Uint8ClampedArray, width: number, height: number): Pix[] {
  const out: Pix[] = [];
  for (let y = 0; y < 32; y++) {
    const y0 = Math.floor((y * height) / 32);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / 32));
    for (let x = 0; x < 32; x++) {
      const x0 = Math.floor((x * width) / 32);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / 32));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          const i = (yy * width + xx) * 4;
          if ((rgba[i + 3] ?? 0) < 16) continue;
          r += rgba[i] ?? 0;
          g += rgba[i + 1] ?? 0;
          b += rgba[i + 2] ?? 0;
          n++;
        }
      }
      out.push(n === 0 ? { r: 0, g: 0, b: 0 } : { r: r / n, g: g / n, b: b / n });
    }
  }
  return out;
}

function medianCut(pixels: Pix[], maxColors: number): Pix[] {
  const boxes: Pix[][] = [pixels.slice()];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestRange = 0;
    let bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.length < 2) continue;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const pixel of box) {
        min[0] = Math.min(min[0]!, pixel.r);
        max[0] = Math.max(max[0]!, pixel.r);
        min[1] = Math.min(min[1]!, pixel.g);
        max[1] = Math.max(max[1]!, pixel.g);
        min[2] = Math.min(min[2]!, pixel.b);
        max[2] = Math.max(max[2]!, pixel.b);
      }
      let channel = 0;
      let range = max[0]! - min[0]!;
      if (max[1]! - min[1]! > range) {
        channel = 1;
        range = max[1]! - min[1]!;
      }
      if (max[2]! - min[2]! > range) {
        channel = 2;
        range = max[2]! - min[2]!;
      }
      if (range > bestRange) {
        bestRange = range;
        best = i;
        bestCh = channel;
      }
    }
    if (best < 0) break;
    const box = boxes[best]!;
    box.sort((a, b) => channelOf(a, bestCh) - channelOf(b, bestCh));
    const mid = Math.floor(box.length / 2);
    if (mid < 1 || mid >= box.length) break;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const pixel of box) {
      r += pixel.r;
      g += pixel.g;
      b += pixel.b;
    }
    const n = box.length || 1;
    return { r: r / n, g: g / n, b: b / n };
  });
}

export function squareImage(rgba: Uint8ClampedArray | null | undefined): RgbaImage | null {
  if (!rgba || rgba.length < 16) return null;
  const side = Math.sqrt(rgba.length / 4);
  if (!Number.isInteger(side) || side < 8) return null;
  return { rgba, width: side, height: side };
}

/** 32×32, 16-color, 4bpp icon the way the NDS banner stores it. */
export function quantizeToBanner(image: RgbaImage): { tiles: Uint8Array; palette: Uint8Array; preview: Uint8ClampedArray } {
  if (image.width < 1 || image.height < 1 || image.rgba.length < image.width * image.height * 4) {
    throw new KgbError("That picture is empty.");
  }
  const pixels = downsample32(image.rgba, image.width, image.height);
  const cuts = medianCut(pixels, 16);
  const colors: number[] = [];
  for (const pixel of cuts) {
    const color = rgb555(Math.round(pixel.r), Math.round(pixel.g), Math.round(pixel.b));
    if (!colors.includes(color)) colors.push(color);
  }
  if (colors.length === 0) colors.push(0);
  while (colors.length < 16) colors.push(colors[colors.length - 1]!);
  const expanded = colors.slice(0, 16).map((color) => expand555(color));
  const index = new Uint8Array(32 * 32);
  for (let i = 0; i < pixels.length; i++) {
    const r = Math.round(pixels[i]!.r);
    const g = Math.round(pixels[i]!.g);
    const b = Math.round(pixels[i]!.b);
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < 16; c++) {
      const [pr, pg, pb] = expanded[c]!;
      const d = (pr - r) * (pr - r) + (pg - g) * (pg - g) + (pb - b) * (pb - b);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    index[i] = best;
  }
  const packed = encodeIcon(index, colors);
  const preview = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < index.length; i++) {
    const [r, g, b] = expanded[index[i]!]!;
    preview[i * 4] = r;
    preview[i * 4 + 1] = g;
    preview[i * 4 + 2] = b;
    preview[i * 4 + 3] = 255;
  }
  return { tiles: packed.tiles, palette: packed.palette, preview };
}

/** What the DS menu will show for this header icon choice. Null image = text seal. */
export function previewHeaderIcon(code: string, image: RgbaImage | null): Uint8ClampedArray {
  const icon = image ? quantizeToBanner(image) : null;
  return decodeBannerIcon(buildBanner("", code || "----", icon)) ?? new Uint8ClampedArray(32 * 32 * 4);
}

function refreshBannerCrcs(banner: Uint8Array) {
  const version = u16(banner, 0) & 0xff;
  if (banner.length >= 0x840) putU16(banner, 2, crc16(banner, 0x20, 0x840));
  if (version >= 2 && banner.length >= 0x940) putU16(banner, 4, crc16(banner, 0x20, 0x940));
  if (version >= 3 && banner.length >= 0xa40) putU16(banner, 6, crc16(banner, 0x20, 0xa40));
}

function appendBanner(source: Uint8Array, picture: { tiles: Uint8Array; palette: Uint8Array }): Uint8Array {
  const bannerOff = alignUp(Math.max(source.length, 0x4000), 0x200);
  const banner = buildBanner(readAscii(source, 0, 12), readAscii(source, 0x0c, 4), picture);
  const out = new Uint8Array(bannerOff + banner.length);
  out.set(source);
  out.set(banner, bannerOff);
  putU32(out, 0x68, bannerOff);
  if (u32(out, 0x80) < out.length) putU32(out, 0x80, out.length);
  let cap = 0;
  let limit = 0x20000;
  while (cap < 14 && limit < out.length) {
    limit *= 2;
    cap++;
  }
  if ((out[0x14] ?? 0) < cap) out[0x14] = cap;
  putU16(out, 0x15e, crc16(out, 0, 0x15e));
  return out;
}

/**
 * Write a picture into the banner referenced by NDS header +0x68.
 * An existing banner is patched in place. A missing one is appended and the header is retargeted.
 */
export function installBannerIcon(source: Uint8Array, image: RgbaImage): Uint8Array {
  if (!isNdsRom(source)) {
    throw new KgbError("Not an NDS cartridge. The Nintendo logo at 0xC0 never matched.");
  }
  const picture = quantizeToBanner(image);
  const bannerOff = u32(source, 0x68);
  const iconFits = bannerOff >= 0x200 && bannerOff + 0x240 <= source.length;
  const crcFits = iconFits && bannerOff + 0x840 <= source.length;
  if (!iconFits || !crcFits) return appendBanner(source, picture);
  const rom = new Uint8Array(source);
  rom.set(picture.tiles, bannerOff + 0x20);
  rom.set(picture.palette, bannerOff + 0x220);
  const version = u16(rom, bannerOff) & 0xff;
  const span = version >= 3 && bannerOff + 0xa40 <= rom.length ? 0xa40 : version >= 2 && bannerOff + 0x940 <= rom.length ? 0x940 : 0x840;
  refreshBannerCrcs(rom.subarray(bannerOff, bannerOff + span));
  return rom;
}

function buildFnt(): Uint8Array {
  const names = ["rom.gba", "readme.txt"];
  let nameBytes = 1;
  for (const name of names) nameBytes += 1 + name.length;
  const fnt = new Uint8Array(8 + nameBytes);
  putU32(fnt, 0, 8);
  putU16(fnt, 4, 0);
  putU16(fnt, 6, 1);
  let p = 8;
  for (const name of names) {
    fnt[p++] = name.length;
    for (let i = 0; i < name.length; i++) fnt[p++] = name.charCodeAt(i);
  }
  fnt[p] = 0;
  return fnt;
}

function deviceCapacity(bytes: number): number {
  let cap = 0x20000;
  let n = 0;
  while (cap < bytes && n < 14) {
    cap *= 2;
    n++;
  }
  return n;
}

function carrierLabel(input: CarrierInput): CarrierLabel {
  const header = readGbaHeader(input.rom);
  return {
    title: input.title || header.title || "UNTITLED",
    gameCode: input.gameCode || header.gameCode || "----",
    maker: input.maker || header.maker || "--",
    version: input.version ?? header.version,
    bytes: input.rom.length,
    checksumOk: input.checksumOk ?? header.checksumOk,
    iconRgba: input.iconRgba,
  };
}

export function packGbaAsNds(input: CarrierInput): Uint8Array {
  if (input.rom.length < 0xc0) {
    throw new KgbError("That file is too small to be a GBA cartridge.");
  }
  const label = carrierLabel(input);
  const screens = renderCarrierScreens(label);
  const arm9 = buildArm9Image(screens.top, screens.bottom);
  const arm7 = Uint8Array.of(0xfe, 0xff, 0xff, 0xea);
  const fnt = buildFnt();
  const bannerIcon = input.bannerImage ? quantizeToBanner(input.bannerImage) : null;
  const banner = buildBanner(label.title, label.gameCode, bannerIcon);
  const readme = new TextEncoder().encode(CARRIER_README);

  let cursor = 0x4000;
  const arm9Off = cursor;
  cursor = alignUp(cursor + arm9.length, 0x200);
  const arm7Off = cursor;
  cursor = alignUp(cursor + arm7.length, 0x200);
  const fntOff = cursor;
  cursor = alignUp(cursor + fnt.length, 0x200);
  const fatOff = cursor;
  cursor = alignUp(cursor + 16, 0x200);
  const bannerOff = cursor;
  cursor = alignUp(cursor + banner.length, 0x200);
  const romOff = cursor;
  cursor += input.rom.length;
  cursor = alignUp(cursor, 4);
  const readmeOff = cursor;
  cursor += readme.length;

  const rom = new Uint8Array(cursor);
  rom.set(arm9, arm9Off);
  rom.set(arm7, arm7Off);
  rom.set(fnt, fntOff);
  putU32(rom, fatOff, romOff);
  putU32(rom, fatOff + 4, romOff + input.rom.length);
  putU32(rom, fatOff + 8, readmeOff);
  putU32(rom, fatOff + 12, readmeOff + readme.length);
  rom.set(banner, bannerOff);
  rom.set(input.rom, romOff);
  rom.set(readme, readmeOff);

  const code = (label.gameCode || "KGBX").toUpperCase().replace(/[^A-Z0-9]/g, "X").padEnd(4, "X").slice(0, 4);
  const maker = (label.maker || "01").toUpperCase().replace(/[^A-Z0-9]/g, "0").padEnd(2, "0").slice(0, 2);
  rom.set(asciiFit(label.title.toUpperCase(), 12), 0);
  rom.set(asciiFit(code, 4), 0x0c);
  rom.set(asciiFit(maker, 2), 0x10);
  rom[0x12] = 0;
  rom[0x13] = 0;
  rom[0x14] = deviceCapacity(rom.length);
  rom[0x1e] = label.version & 0xff;
  putU32(rom, 0x20, arm9Off);
  putU32(rom, 0x24, ARM9_RAM);
  putU32(rom, 0x28, ARM9_RAM);
  putU32(rom, 0x2c, arm9.length);
  putU32(rom, 0x30, arm7Off);
  putU32(rom, 0x34, ARM7_RAM);
  putU32(rom, 0x38, ARM7_RAM);
  putU32(rom, 0x3c, arm7.length);
  putU32(rom, 0x40, fntOff);
  putU32(rom, 0x44, fnt.length);
  putU32(rom, 0x48, fatOff);
  putU32(rom, 0x4c, 16);
  putU32(rom, 0x60, 0x00586000);
  putU32(rom, 0x64, 0x001808f8);
  putU32(rom, 0x68, bannerOff);
  putU16(rom, 0x6c, crc16(rom, 0x4000, 0x8000));
  putU16(rom, 0x6e, 0x051e);
  putU32(rom, 0x80, rom.length);
  putU32(rom, 0x84, 0x4000);
  rom.set(NDS_LOGO, 0xc0);
  putU16(rom, 0x15c, crc16(rom, 0xc0, 0x15c));
  putU16(rom, 0x15e, crc16(rom, 0x00, 0x15e));
  return rom;
}

function listNitro(rom: Uint8Array): NdsFile[] {
  const fntOff = u32(rom, 0x40);
  const fntSize = u32(rom, 0x44);
  const fatOff = u32(rom, 0x48);
  const fatSize = u32(rom, 0x4c);
  if (fntOff < 0x200 || fntSize < 8 || fatOff < 0x200 || fatSize < 8) return [];
  if (fntOff + fntSize > rom.length || fatOff + fatSize > rom.length) return [];
  const dirCount = u16(rom, fntOff + 6);
  if (dirCount < 1 || dirCount > 1024) return [];
  const files: NdsFile[] = [];
  const seen = new Set<number>();

  const walk = (dirId: number, prefix: string, depth: number) => {
    if (depth > 6 || seen.has(dirId)) return;
    seen.add(dirId);
    const idx = dirId - 0xf000;
    if (idx < 0 || idx >= dirCount) return;
    const base = fntOff + idx * 8;
    if (base + 8 > fntOff + fntSize) return;
    let p = fntOff + u32(rom, base);
    let fileId = u16(rom, base + 4);
    const end = fntOff + fntSize;
    let guard = 0;
    while (p < end && guard++ < 4000) {
      const len = rom[p++]!;
      if (len === 0) break;
      const isDir = (len & 0x80) !== 0;
      const n = len & 0x7f;
      if (p + n > end) break;
      let name = "";
      for (let i = 0; i < n; i++) name += String.fromCharCode(rom[p + i]!);
      p += n;
      if (isDir) {
        if (p + 2 > end) break;
        const sub = u16(rom, p);
        p += 2;
        walk(sub, `${prefix}${name}/`, depth + 1);
      } else {
        const slot = fileId++;
        if (slot * 8 + 8 > fatSize) continue;
        const start = u32(rom, fatOff + slot * 8);
        const stop = u32(rom, fatOff + slot * 8 + 4);
        files.push({ name: prefix + name, start, size: stop >= start ? stop - start : 0 });
      }
    }
  };
  walk(0xf000, "", 0);
  return files;
}

function pickGba(rom: Uint8Array, files: NdsFile[]): EmbeddedGba | null {
  const ranked = [...files].sort((a, b) => {
    const score = (file: NdsFile) => {
      const name = file.name.toLowerCase();
      if (name === "rom.gba" || name.endsWith("/rom.gba")) return 0;
      if (/\.(gba|agb|mb)$/.test(name)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  for (const file of ranked) {
    if (file.size < 0xc0 || file.start + file.size > rom.length) continue;
    const bytes = rom.slice(file.start, file.start + file.size);
    const header = readGbaHeader(bytes);
    if (!header.logoOk) continue;
    return { name: file.name, rom: bytes, header };
  }
  return null;
}

export function parseNds(source: ArrayBuffer | Uint8Array, fileName: string): NdsInfo {
  const rom = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (!isNdsRom(rom)) {
    throw new KgbError("Not an NDS cartridge. The Nintendo logo at 0xC0 never matched.");
  }
  const warnings: string[] = [];
  const logoCrc = crc16(rom, 0xc0, 0x15c);
  const headerCrc = crc16(rom, 0, 0x15e);
  const logoCrcOk = logoCrc === u16(rom, 0x15c);
  const headerCrcOk = headerCrc === u16(rom, 0x15e);
  if (!logoCrcOk) warnings.push("Logo CRC does not match. The header may be damaged.");
  if (!headerCrcOk) warnings.push("Header CRC does not match. Treat the fields below as unverified.");
  const unit = rom[0x12] ?? 0;
  if (unit === 2) warnings.push("Unit code says DSi. Filesystem fields are still read as an NDS cart.");

  let bannerTitle = "";
  let iconRgba: Uint8ClampedArray | null = null;
  const bannerOff = u32(rom, 0x68);
  if (bannerOff >= 0x200 && bannerOff + 0x840 <= rom.length) {
    const banner = rom.subarray(bannerOff, bannerOff + 0x840);
    const expect = crc16(banner, 0x20, 0x840);
    if (expect !== u16(banner, 2)) warnings.push("Banner CRC does not match. The icon may be garbled.");
    bannerTitle = readUtf16(banner, 0x340) || readUtf16(banner, 0x240);
    iconRgba = decodeBannerIcon(banner);
  } else {
    warnings.push("No banner. The DS menu would show a blank icon.");
  }

  const files = listNitro(rom);
  const gba = pickGba(rom, files);
  if (!gba) {
    warnings.push("No GBA image in the filesystem. A native DS game cannot be turned into a GBA ROM.");
  }

  return {
    fileName,
    fileSize: rom.length,
    title: readAscii(rom, 0, 12),
    gameCode: readAscii(rom, 0x0c, 4),
    maker: readAscii(rom, 0x10, 2),
    unitCode: unit,
    romVersion: rom[0x1e] ?? 0,
    romSizeField: u32(rom, 0x80),
    headerCrcOk,
    logoCrcOk,
    bannerTitle,
    bannerOffset: bannerOff,
    iconRgba,
    files,
    gba,
    warnings,
  };
}
