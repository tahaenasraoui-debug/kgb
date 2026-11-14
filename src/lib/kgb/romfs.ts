import { findGbRom, matchGbLogo, readGbHeader, verifyGbChecksum, type GbHeader } from "./gb.ts";

function u32(data: Uint8Array, off: number): number {
  return (data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16) | (data[off + 3]! << 24)) >>> 0;
}

export type ExtractedGbRom = {
  rom: Uint8Array;
  header: GbHeader;
  source: "romfs-file" | "romfs-scan";
  path?: string;
};

/**
 * Attempts to extract a Game Boy / Game Boy Color ROM from the RomFS partition of a 3DS NCCH container.
 */
export function extractGbRomFromRomfs(data: Uint8Array, ncchOffset: number, romfsMedia: number): ExtractedGbRom | null {
  if (romfsMedia <= 0) return null;
  const romfsOffset = ncchOffset + romfsMedia * 0x200;
  if (romfsOffset >= data.length) return null;

  // 1. Try structured Level 3 RomFS parsing
  try {
    const l3 = findLevel3Offset(data, romfsOffset);
    if (l3 !== null && l3 + 0x28 <= data.length) {
      const headerLen = u32(data, l3 + 0x00);
      const fileMetaOff = u32(data, l3 + 0x1c);
      const fileMetaLen = u32(data, l3 + 0x20);
      const fileDataOff = u32(data, l3 + 0x24);

      if (headerLen >= 0x28 && fileMetaOff > 0 && fileMetaLen > 0 && fileDataOff > 0) {
        const metaStart = l3 + fileMetaOff;
        const metaEnd = metaStart + fileMetaLen;
        const dataBase = l3 + fileDataOff;

        if (metaEnd <= data.length) {
          let p = metaStart;
          while (p + 0x20 <= metaEnd) {
            const dataOffLo = u32(data, p + 0x08);
            const dataOffHi = u32(data, p + 0x0c);
            const dataSizeLo = u32(data, p + 0x10);
            const dataSizeHi = u32(data, p + 0x14);
            const nameLen = u32(data, p + 0x1c);

            const dataOff = dataOffHi === 0 ? dataOffLo : dataOffHi * 0x100000000 + dataOffLo;
            const dataSize = dataSizeHi === 0 ? dataSizeLo : dataSizeHi * 0x100000000 + dataSizeLo;

            if (nameLen > 0 && p + 0x20 + nameLen <= metaEnd) {
              let name = "";
              for (let i = 0; i < nameLen; i += 2) {
                const code = data[p + 0x20 + i]! | (data[p + 0x20 + i + 1]! << 8);
                if (code === 0) break;
                name += String.fromCharCode(code);
              }

              if (dataSize >= 0x150 && dataBase + dataOff + dataSize <= data.length) {
                const candidate = data.subarray(dataBase + dataOff, dataBase + dataOff + dataSize);
                // Check if candidate starts with a Game Boy cartridge header or contains one
                if (matchGbLogo(candidate, 0x104) && verifyGbChecksum(candidate, 0x100)) {
                  const header = readGbHeader(candidate, 0x100);
                  return {
                    rom: candidate.slice(),
                    header,
                    source: "romfs-file",
                    path: name,
                  };
                }
              }
            }

            const entrySize = (0x20 + nameLen + 3) & ~3;
            if (entrySize <= 0) break;
            p += entrySize;
          }
        }
      }
    }
  } catch {
    // Continue to fallback scan
  }

  // 2. Fallback: Scan the RomFS slice for a valid Game Boy cartridge signature
  const romfsSlice = data.subarray(romfsOffset);
  const found = findGbRom(romfsSlice);
  if (found) {
    const rom = romfsSlice.slice(found.start, found.start + found.size);
    return {
      rom,
      header: found.header,
      source: "romfs-scan",
    };
  }

  return null;
}

function findLevel3Offset(data: Uint8Array, romfsOffset: number): number | null {
  // Check IVFC magic
  if (
    data[romfsOffset] === 0x49 && // 'I'
    data[romfsOffset + 1] === 0x56 && // 'V'
    data[romfsOffset + 2] === 0x46 && // 'F'
    data[romfsOffset + 3] === 0x43 // 'C'
  ) {
    // Level 3 logical offset is at +0x3c (u64 little-endian)
    const lo = u32(data, romfsOffset + 0x3c);
    const hi = u32(data, romfsOffset + 0x40);
    const l3Logical = hi === 0 ? lo : hi * 0x100000000 + lo;
    return romfsOffset + l3Logical;
  }

  // If header directly starts with 0x28 (direct Level 3 RomFS header)
  if (data[romfsOffset] === 0x28 && data[romfsOffset + 1] === 0 && data[romfsOffset + 2] === 0 && data[romfsOffset + 3] === 0) {
    return romfsOffset;
  }

  // Common offset in some tools: 0x1000
  if (
    romfsOffset + 0x1000 + 4 <= data.length &&
    data[romfsOffset + 0x1000] === 0x28 &&
    data[romfsOffset + 0x1001] === 0
  ) {
    return romfsOffset + 0x1000;
  }

  return null;
}
