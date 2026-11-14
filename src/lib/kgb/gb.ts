import { asciiField } from "./format.ts";

export const GB_LOGO = Uint8Array.of(
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
);

const CART_TYPES: Record<number, string> = {
  0x00: "ROM ONLY",
  0x01: "MBC1",
  0x02: "MBC1+RAM",
  0x03: "MBC1+RAM+BATTERY",
  0x05: "MBC2",
  0x06: "MBC2+BATTERY",
  0x08: "ROM+RAM",
  0x09: "ROM+RAM+BATTERY",
  0x0b: "MMM01",
  0x0c: "MMM01+RAM",
  0x0d: "MMM01+RAM+BATTERY",
  0x0f: "MBC3+TIMER+BATTERY",
  0x10: "MBC3+TIMER+RAM+BATTERY",
  0x11: "MBC3",
  0x12: "MBC3+RAM",
  0x13: "MBC3+RAM+BATTERY",
  0x19: "MBC5",
  0x1a: "MBC5+RAM",
  0x1b: "MBC5+RAM+BATTERY",
  0x1c: "MBC5+RUMBLE",
  0x1d: "MBC5+RUMBLE+RAM",
  0x1e: "MBC5+RUMBLE+RAM+BATTERY",
  0x20: "MBC6",
  0x22: "MBC7+SENSOR+RUMBLE+RAM+BATTERY",
  0xfc: "POCKET CAMERA",
  0xfd: "BANDAI TAMA5",
  0xfe: "HuC3",
  0xff: "HuC1+RAM+BATTERY",
};

const RAM_SIZES: Record<number, number> = {
  0x00: 0,
  0x01: 2 * 1024,
  0x02: 8 * 1024,
  0x03: 32 * 1024,
  0x04: 128 * 1024,
  0x05: 64 * 1024,
};

export type GbHeader = {
  title: string;
  manufacturerCode: string;
  cgbFlag: number;
  cgbSupported: boolean;
  cgbOnly: boolean;
  newLicensee: string;
  sgbFlag: number;
  cartridgeType: number;
  cartridgeTypeName: string;
  romSizeCode: number;
  romSizeBytes: number;
  ramSizeCode: number;
  ramSizeBytes: number;
  destinationCode: number;
  destination: string;
  oldLicensee: number;
  version: number;
  headerChecksum: number;
  checksumOk: boolean;
  logoOk: boolean;
};

export function matchGbLogo(bytes: Uint8Array, offset = 0x104): boolean {
  if (bytes.length < offset + 48) return false;
  for (let i = 0; i < 48; i++) {
    if (bytes[offset + i] !== GB_LOGO[i]) return false;
  }
  return true;
}

export function verifyGbChecksum(bytes: Uint8Array, headerOffset = 0x100): boolean {
  if (bytes.length < headerOffset + 0x50) return false;
  let chk = 0;
  for (let i = headerOffset + 0x34; i <= headerOffset + 0x4c; i++) {
    chk = (chk - (bytes[i] ?? 0) - 1) & 0xff;
  }
  return chk === (bytes[headerOffset + 0x4d] ?? -1);
}

export function readGbHeader(bytes: Uint8Array, headerOffset = 0x100): GbHeader {
  const logoOk = matchGbLogo(bytes, headerOffset + 0x04);
  const checksumOk = verifyGbChecksum(bytes, headerOffset);

  const cgbFlag = bytes[headerOffset + 0x43] ?? 0;
  const cgbSupported = (cgbFlag & 0x80) !== 0 || cgbFlag === 0xc0;
  const cgbOnly = cgbFlag === 0xc0;

  // Title: up to 16 bytes. If CGB flag present or 4-char manufacturer code, title is 11-15 bytes
  let titleLen = 16;
  if (cgbSupported || cgbOnly) titleLen = 11;
  const title = asciiField(bytes, headerOffset + 0x34, titleLen).trim();
  const manufacturerCode = (cgbSupported || cgbOnly) ? asciiField(bytes, headerOffset + 0x3f, 4).trim() : "";

  const newLicensee = asciiField(bytes, headerOffset + 0x44, 2);
  const sgbFlag = bytes[headerOffset + 0x46] ?? 0;
  const cartridgeType = bytes[headerOffset + 0x47] ?? 0;
  const cartridgeTypeName = CART_TYPES[cartridgeType] || `Unknown (0x${cartridgeType.toString(16)})`;

  const romSizeCode = bytes[headerOffset + 0x48] ?? 0;
  let romSizeBytes = 32768;
  if (romSizeCode <= 8) {
    romSizeBytes = 32768 << romSizeCode;
  } else if (romSizeCode === 0x52) {
    romSizeBytes = Math.floor(1.1 * 1024 * 1024);
  } else if (romSizeCode === 0x53) {
    romSizeBytes = Math.floor(1.2 * 1024 * 1024);
  } else if (romSizeCode === 0x54) {
    romSizeBytes = Math.floor(1.5 * 1024 * 1024);
  }

  const ramSizeCode = bytes[headerOffset + 0x49] ?? 0;
  const ramSizeBytes = RAM_SIZES[ramSizeCode] ?? 0;

  const destinationCode = bytes[headerOffset + 0x4a] ?? 0;
  const destination = destinationCode === 0 ? "Japan" : "Non-Japan";
  const oldLicensee = bytes[headerOffset + 0x4b] ?? 0;
  const version = bytes[headerOffset + 0x4c] ?? 0;
  const headerChecksum = bytes[headerOffset + 0x4d] ?? 0;

  return {
    title: title || "UNTITLED",
    manufacturerCode,
    cgbFlag,
    cgbSupported,
    cgbOnly,
    newLicensee,
    sgbFlag,
    cartridgeType,
    cartridgeTypeName,
    romSizeCode,
    romSizeBytes,
    ramSizeCode,
    ramSizeBytes,
    destinationCode,
    destination,
    oldLicensee,
    version,
    headerChecksum,
    checksumOk,
    logoOk,
  };
}

/**
 * Searches a binary buffer for a Game Boy cartridge header (Logo + Checksum).
 * Returns the offset of the ROM start (which is headerOffset - 0x100) and length.
 */
export function findGbRom(data: Uint8Array): { start: number; size: number; header: GbHeader } | null {
  const firstByte = GB_LOGO[0]!;
  const limit = data.length - 0x150;
  // Game Boy headers are usually aligned to 0x100 or 0x200 or 0x4000
  for (let p = 0; p <= limit; p++) {
    if (data[p + 0x104] === firstByte && matchGbLogo(data, p + 0x104) && verifyGbChecksum(data, p + 0x100)) {
      const header = readGbHeader(data, p + 0x100);
      let size = header.romSizeBytes;
      if (p + size > data.length) {
        size = data.length - p;
      }
      return { start: p, size, header };
    }
  }
  return null;
}
