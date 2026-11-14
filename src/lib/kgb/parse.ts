import { blzDecompress } from "./blz.ts";
import { findCaaFooter, findRomStart, readCaa, readGbaHeader } from "./gba.ts";
import { asciiField } from "./format.ts";
import { parseSmdh } from "./smdh.ts";
import { readGbHeader, type GbHeader } from "./gb.ts";
import { extractGbRomFromRomfs } from "./romfs.ts";
import { makeEmptyCaa, KgbError, type Dossier, type GbaHeader, type Offsets, type SystemKind } from "./types.ts";

function align64(x: number): number {
  return (x + 0x3f) & ~0x3f;
}

function u32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

function nameAt(data: Uint8Array, off: number): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    const c = data[off + i] ?? 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function parseCia(buffer: ArrayBuffer | ArrayBufferLike, fileName = "title.cia"): Dossier {
  const warnings: string[] = [];
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (data.length < 0x200) {
    throw new KgbError("File is too small to be a CIA or NCCH.", warnings);
  }

  let ncch: number;
  let certSize = 0;
  let ticketSize = 0;
  let tmdSize = 0;
  let metaSize = 0;
  let contentSize = 0;
  let headerSize = 0;

  const magicAt100 = asciiField(data, 0x100, 4);
  if (magicAt100 === "NCCH") {
    ncch = 0;
    warnings.push("Input is a bare NCCH/CXI, not a CIA wrapper. Parsing the container directly.");
  } else {
    if (data.length < 0x20) throw new KgbError("CIA header is truncated.", warnings);
    headerSize = u32(view, 0x00);
    certSize = u32(view, 0x08);
    ticketSize = u32(view, 0x0c);
    tmdSize = u32(view, 0x10);
    metaSize = u32(view, 0x14);
    const contentLo = u32(view, 0x18);
    const contentHi = u32(view, 0x1c);
    contentSize = contentHi === 0 ? contentLo : contentHi * 0x100000000 + contentLo;
    if (headerSize < 0x20 || headerSize > data.length) {
      throw new KgbError(`CIA header size ${headerSize} is not plausible.`, warnings);
    }
    ncch = align64(headerSize) + align64(certSize) + align64(ticketSize) + align64(tmdSize);
  }

  if (ncch + 0x200 > data.length) {
    throw new KgbError(`NCCH offset ${ncch} is past the end of the file.`, warnings);
  }
  const magic = asciiField(data, ncch + 0x100, 4);
  if (magic !== "NCCH") {
    throw new KgbError(
      `Expected NCCH magic at ${ncch + 0x100}, found "${magic || "—"}". This is not an unwrapped 3DS CIA.`,
      warnings,
    );
  }

  const titleLo = u32(view, ncch + 0x118);
  const titleHi = u32(view, ncch + 0x11c);
  const titleId = titleHi.toString(16).toUpperCase().padStart(8, "0") + titleLo.toString(16).toUpperCase().padStart(8, "0");
  const productCode = asciiField(data, ncch + 0x150, 16);
  const noCrypto = (data[ncch + 0x18f]! & 0x04) !== 0;
  const encrypted = !noCrypto;
  if (encrypted) {
    warnings.push("NCCH flags[7] NoCrypto is clear. The content is probably still AES-encrypted; the ROM scan will fail.");
  }

  const exefsMedia = u32(view, ncch + 0x1a0);
  const exefs = ncch + exefsMedia * 0x200;
  const exefsBytes = exefs;
  const romfsMedia = ncch + 0x1b0 + 4 <= data.length ? u32(view, ncch + 0x1b0) : 0;
  let codeCompressed = false;
  // ExHeader system-control-info flag byte: bit0 = compress .code with BLZ (3DBrew ExHeader).
  if (ncch + 0x200 + 0x0d < exefsBytes && ncch + 0x20d < data.length) {
    codeCompressed = (data[ncch + 0x200 + 0x0d]! & 0x01) !== 0;
  }

  if (exefsMedia === 0 || exefs + 0x200 > data.length) {
    throw new KgbError("ExeFS offset is missing or points outside the file.", warnings);
  }

  const exefsNames: string[] = [];
  let codeOff = -1;
  let codeSize = 0;
  let iconOff = -1;
  let iconSize = 0;
  for (let i = 0; i < 10; i++) {
    const ent = exefs + i * 16;
    const name = nameAt(data, ent);
    exefsNames.push(name);
    if (!name) continue;
    const off = u32(view, ent + 8);
    const size = u32(view, ent + 12);
    const abs = exefs + 0x200 + off;
    if (name === ".code" || name === "code") {
      codeOff = abs;
      codeSize = size;
    } else if (name === "icon") {
      iconOff = abs;
      iconSize = size;
    }
  }

  // Parse SMDH icon and metadata
  let smdh: Dossier["smdh"] = null;
  let iconRgba: Uint8ClampedArray | null = null;
  if (iconOff >= 0 && iconSize > 0 && iconOff + iconSize <= data.length) {
    const parsed = parseSmdh(data.subarray(iconOff, iconOff + iconSize));
    if (!parsed) warnings.push('ExeFS "icon" is not an SMDH (magic mismatch).');
    else {
      smdh = parsed.titles;
      iconRgba = parsed.icon;
    }
  } else {
    warnings.push("No SMDH icon in ExeFS.");
  }

  if (codeOff < 0 || codeSize <= 0) {
    throw new KgbError(`ExeFS has no .code file. Names: ${exefsNames.filter(Boolean).join(", ") || "none"}.`, warnings);
  }
  if (codeOff + codeSize > data.length) {
    throw new KgbError(".code extends past the end of the file.", warnings);
  }

  let code: Uint8Array = data.subarray(codeOff, codeOff + codeSize);
  let decompressed = false;
  if (codeCompressed) {
    try {
      code = blzDecompress(code);
      decompressed = true;
      warnings.push("ExeFS .code was BLZ-compressed and has been decompressed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "BLZ failed";
      warnings.push(`Compressed-.code flag is set but BLZ failed (${msg}). Scanning the raw bytes.`);
    }
  }

  const partialBase = { fileName, fileSize: data.length, titleId, productCode, encrypted, exefsNames };

  const romStart = findRomStart(code);

  // If no GBA header is found in .code, check if this is a Game Boy (GB/GBC) Virtual Console RomFS title!
  if (romStart === null) {
    if (romfsMedia > 0) {
      const gbResult = extractGbRomFromRomfs(data, ncch, romfsMedia);
      if (gbResult) {
        const gb = gbResult.header;
        const system: SystemKind = gb.cgbOnly ? "gbc" : "gb";
        warnings.push(
          `Extracted Game Boy (${system.toUpperCase()}) ROM "${gb.title}" from 3DS Virtual Console RomFS (${gbResult.source}).`,
        );

        const gba: GbaHeader = {
          title: gb.title,
          gameCode: gb.manufacturerCode || gb.title.replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "-"),
          maker: gb.newLicensee || "01",
          version: gb.version,
          checksum: gb.headerChecksum,
          checksumOk: gb.checksumOk,
          logoOk: gb.logoOk,
        };

        const offsets: Offsets = {
          ciaHeader: headerSize,
          certSize,
          ticketSize,
          tmdSize,
          metaSize,
          contentSize,
          ncch,
          exefs,
          codeInFile: codeOff,
          iconInFile: iconOff,
          preambleInCode: 0,
          romStartInCode: 0,
          footerInCode: 0,
          romInFile: ncch + romfsMedia * 0x200,
        };

        return {
          fileName,
          fileSize: data.length,
          system,
          titleId,
          productCode,
          encrypted,
          codeCompressed,
          decompressed,
          exefsNames,
          offsets,
          preambleBytes: 0,
          gba,
          gb,
          caa: makeEmptyCaa(),
          rom: gbResult.rom,
          romSizeFieldTrusted: true,
          smdh,
          iconRgba,
          warnings,
        };
      }
    }

    let detail = "No GBA or GB/GBC cartridge header found in .code or RomFS.";
    if (encrypted) {
      detail = "No cartridge header found. The CIA looks encrypted — KGB only reads NoCrypto injects. Rebuild the CIA as NoCrypto with vcoven or NSUI (decrypt with GodMode9 first if it is a personal dump), then try again.";
    } else if (romfsMedia > 0) {
      detail = "This CIA contains a RomFS partition, but no valid GBA, Game Boy (GB), or Game Boy Color (GBC) ROM was recognized inside.";
    }
    throw new KgbError(detail, warnings, partialBase);
  }

  const footerHit = findCaaFooter(code);
  if (!footerHit) throw new KgbError(".code is too small to contain a 0x360 AGB_FIRM footer.", warnings, partialBase);
  if (!footerHit.trustedMagic) {
    warnings.push("'.CAA' magic was not found. Using the last 0x360 bytes as a fallback footer.");
  }
  const caa = readCaa(code, footerHit.start, footerHit.trustedMagic);
  if (caa.version !== 1 && footerHit.trustedMagic) {
    warnings.push(`.CAA version is ${caa.version}, expected 1.`);
  }

  let romEnd = romStart + caa.romSize;
  let trusted = true;
  const footerStart = footerHit.start;
  if (!(caa.romSize >= 0xc0 && romEnd <= footerStart && romEnd <= code.length && romEnd > romStart)) {
    trusted = false;
    romEnd = footerStart;
    warnings.push(
      `Footer rom_size 0x${caa.romSize.toString(16)} is not usable. Slicing from the GBA header to the .CAA footer instead.`,
    );
  } else if (romEnd < footerStart) {
    warnings.push(
      `${footerStart - romEnd} bytes sit between the declared ROM end and the .CAA footer (left out of the .gba).`,
    );
  }

  const rom = code.slice(romStart, romEnd);
  const gba = readGbaHeader(rom);
  if (!gba.checksumOk) warnings.push("GBA header checksum or fixed 0x96 byte does not verify.");

  if (romStart === 0x2000) {
    warnings.push("Stripped an 8192-byte AGB_FIRM boot preamble before the cartridge header.");
  } else if (romStart > 0) {
    warnings.push(`Stripped a ${romStart}-byte preamble before the cartridge header.`);
  }

  const offsets: Offsets = {
    ciaHeader: headerSize,
    certSize,
    ticketSize,
    tmdSize,
    metaSize,
    contentSize,
    ncch,
    exefs,
    codeInFile: codeOff,
    iconInFile: iconOff,
    preambleInCode: 0,
    romStartInCode: romStart,
    footerInCode: footerStart,
    romInFile: codeOff + romStart,
  };

  return {
    fileName,
    fileSize: data.length,
    system: "gba",
    titleId,
    productCode,
    encrypted,
    codeCompressed,
    decompressed,
    exefsNames,
    offsets,
    preambleBytes: romStart,
    gba,
    caa,
    rom,
    romSizeFieldTrusted: trusted,
    smdh,
    iconRgba,
    warnings,
  };
}

/**
 * Creates a Dossier from a standalone Game Boy or Game Boy Color ROM file (.gb or .gbc).
 */
export function parseGbFile(buffer: ArrayBuffer | ArrayBufferLike, fileName: string): Dossier {
  const bytes = new Uint8Array(buffer);
  const gb = readGbHeader(bytes);
  const system: SystemKind = gb.cgbOnly ? "gbc" : "gb";
  const gba: GbaHeader = {
    title: gb.title,
    gameCode: gb.manufacturerCode || gb.title.replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "-"),
    maker: gb.newLicensee || "01",
    version: gb.version,
    checksum: gb.headerChecksum,
    checksumOk: gb.checksumOk,
    logoOk: gb.logoOk,
  };

  const offsets: Offsets = {
    ciaHeader: 0,
    certSize: 0,
    ticketSize: 0,
    tmdSize: 0,
    metaSize: 0,
    contentSize: bytes.length,
    ncch: 0,
    exefs: 0,
    codeInFile: 0,
    iconInFile: -1,
    preambleInCode: 0,
    romStartInCode: 0,
    footerInCode: 0,
    romInFile: 0,
  };

  const warnings: string[] = [];
  if (!gb.checksumOk) warnings.push("Game Boy header checksum does not match.");
  if (!gb.logoOk) warnings.push("Nintendo Game Boy logo at 0x104 does not match.");

  return {
    fileName,
    fileSize: bytes.length,
    system,
    titleId: "0000000000000000",
    productCode: gb.manufacturerCode || "DMG-GAME",
    encrypted: false,
    codeCompressed: false,
    decompressed: false,
    exefsNames: [],
    offsets,
    preambleBytes: 0,
    gba,
    gb,
    caa: makeEmptyCaa(),
    rom: bytes,
    romSizeFieldTrusted: true,
    smdh: null,
    iconRgba: null,
    warnings,
  };
}
