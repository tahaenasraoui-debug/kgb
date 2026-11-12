import type { Dossier, SaveInfo } from "./types.ts";

/** Hardware save-type IDs from AGB_FIRM / GBATEK ARM7_SAVE_TYPE. */
export function describeSave(id: number): SaveInfo {
  const table: Record<number, Omit<SaveInfo, "id">> = {
    0x00: { name: "EEPROM 512 bytes", rtc: false, bytes: 512, alias: "4 Kbit · <256 Mbit ROM" },
    0x01: { name: "EEPROM 512 bytes", rtc: false, bytes: 512, alias: "4 Kbit · 256 Mbit ROM" },
    0x02: { name: "EEPROM 8 KiB", rtc: false, bytes: 8192, alias: "64 Kbit · <256 Mbit ROM" },
    0x03: { name: "EEPROM 8 KiB", rtc: false, bytes: 8192, alias: "64 Kbit · 256 Mbit ROM" },
    0x04: { name: "FLASH 64 KiB Atmel + RTC", rtc: true, bytes: 65536, alias: "512 Kbit · ID 3D1F" },
    0x05: { name: "FLASH 64 KiB Atmel", rtc: false, bytes: 65536, alias: "512 Kbit · ID 3D1F" },
    0x06: { name: "FLASH 64 KiB SST + RTC", rtc: true, bytes: 65536, alias: "512 Kbit · ID D4BF" },
    0x07: { name: "FLASH 64 KiB SST", rtc: false, bytes: 65536, alias: "512 Kbit · ID D4BF" },
    0x08: { name: "FLASH 64 KiB Panasonic + RTC", rtc: true, bytes: 65536, alias: "512 Kbit · ID 1B32" },
    0x09: { name: "FLASH 64 KiB Panasonic", rtc: false, bytes: 65536, alias: "512 Kbit · ID 1B32" },
    0x0a: { name: "FLASH 128 KiB Macronix + RTC", rtc: true, bytes: 131072, alias: "1 Mbit · ID 09C2" },
    0x0b: { name: "FLASH 128 KiB Macronix", rtc: false, bytes: 131072, alias: "1 Mbit · ID 09C2" },
    0x0c: { name: "FLASH 128 KiB Sanyo + RTC", rtc: true, bytes: 131072, alias: "1 Mbit · ID 1362" },
    0x0d: { name: "FLASH 128 KiB Sanyo", rtc: false, bytes: 131072, alias: "1 Mbit · ID 1362" },
    0x0e: { name: "SRAM / FRAM 32 KiB", rtc: false, bytes: 32768, alias: "256 Kbit" },
  };
  const known = table[id];
  if (known) return { id, ...known };
  return { id, name: "No save chip", rtc: false, bytes: null, alias: "AGB_FIRM stores nothing" };
}

export function hex(n: number, width = 8): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return "0x" + Math.trunc(n).toString(16).toUpperCase().padStart(width, "0");
}

export function hexBytes(data: Uint8Array, max?: number): string {
  const n = max === undefined ? data.length : Math.min(max, data.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(data[i]!.toString(16).toUpperCase().padStart(2, "0"));
  return parts.join(" ");
}

export function asciiField(data: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    const c = data[start + i] ?? 0;
    if (c === 0) break;
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "";
  }
  return out.trim();
}

export function utf16le(data: Uint8Array, start: number, bytes: number): string {
  const slice = data.subarray(start, start + bytes);
  const even = slice.length - (slice.length % 2);
  const view = new DataView(slice.buffer, slice.byteOffset, even);
  let out = "";
  for (let i = 0; i < even; i += 2) {
    const c = view.getUint16(i, true);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out.replace(/\0/g, "").trim();
}

export function sanitizeFile(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "extracted";
}

export function romDownloadName(gbaTitle: string, gameCode: string): string {
  const title = sanitizeFile(gbaTitle || "untitled");
  const code = sanitizeFile(gameCode || "----");
  return `${title} [${code}].gba`;
}

export function ndsDownloadName(gbaTitle: string, gameCode: string): string {
  const title = sanitizeFile(gbaTitle || "untitled");
  const code = sanitizeFile(gameCode || "----");
  return `${title} [${code}].nds`;
}

export function ghostingLabel(value: number): string {
  if (value >= 0xf0) return "none / minimal";
  if (value >= 0x80) return "light";
  if (value >= 0x20) return "moderate";
  if (value > 0) return "heavy";
  return "unset";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function trimTrailingFf(rom: Uint8Array): { bytes: Uint8Array; trimmed: number } {
  let end = rom.length;
  while (end > 0xc0 && rom[end - 1] === 0xff) end--;
  if (end === rom.length) return { bytes: rom, trimmed: 0 };
  return { bytes: rom.slice(0, end), trimmed: rom.length - end };
}

export function dossierLog(d: Dossier): string[] {
  const o = d.offsets;
  const lines = [
    `FILE  ${d.fileName}  ${formatBytes(d.fileSize)}`,
    `CIA   header ${hex(o.ciaHeader)}   cert ${hex(o.certSize, 4)}  ticket ${hex(o.ticketSize, 4)}  tmd ${hex(o.tmdSize, 4)}`,
    `NCCH  ${hex(o.ncch)}   magic OK   title ${d.titleId}`,
    `FLAG  ${d.encrypted ? "CRYPTO SET — payload may be ciphertext" : "NoCrypto (flags[7] bit2)"}   product ${d.productCode || "—"}`,
    `EXEFS ${hex(o.exefs)}   files ${d.exefsNames.filter(Boolean).join(" ") || "—"}`,
    `CODE  ${hex(o.codeInFile)}   ${d.codeCompressed ? (d.decompressed ? "BLZ decompressed" : "BLZ flag set") : "uncompressed .code"}`,
    `ROM   .code+${hex(o.romStartInCode)}   preamble ${d.preambleBytes} bytes${d.preambleBytes === 0x2000 ? "  (vcoven 0x2000 boot)" : ""}`,
    `HEAD  "${d.gba.title || "—"}"  ${d.gba.gameCode || "----"}  maker ${d.gba.maker || "--"}  ver ${d.gba.version}  chk ${d.gba.checksumOk ? "OK" : "BAD"}`,
    `CAA   .code+${hex(o.footerInCode)}   magic ${d.caa.magicOk ? ".CAA" : "MISSING"}   rom_size ${hex(d.caa.romSize)} ${d.romSizeFieldTrusted ? "trusted" : "FALLBACK"}`,
    `SAVE  ${hex(d.caa.save.id, 2)}  ${d.caa.save.name}   RTC ${d.caa.save.rtc ? "YES" : "NO"}`,
    `LCD   ghosting ${hex(d.caa.lcdGhosting, 2)}  ${ghostingLabel(d.caa.lcdGhosting)}   sleep ${hex(d.caa.sleepCombo, 4)}`,
    `OUT   ${formatBytes(d.rom.length)} bit-perfect .gba`,
  ];
  for (const w of d.warnings) lines.push(`WARN  ${w}`);
  return lines;
}

export function caaJson(d: Dossier, trimmed: boolean, outSize: number): string {
  const lut = hexBytes(d.caa.videoLut).replace(/ /g, "");
  const body = {
    tool: "KGB",
    title_id: d.titleId,
    product_code: d.productCode,
    encrypted: d.encrypted,
    code_compressed: d.codeCompressed,
    warnings: d.warnings,
    offsets: {
      cia_header: d.offsets.ciaHeader,
      ncch: d.offsets.ncch,
      exefs: d.offsets.exefs,
      code_in_file: d.offsets.codeInFile,
      agb_firm_preamble_in_code: d.offsets.preambleInCode,
      gba_rom_start_in_code: d.offsets.romStartInCode,
      caa_footer_in_code: d.offsets.footerInCode,
      rom_in_file: d.offsets.romInFile,
      smdh_icon_in_file: d.offsets.iconInFile,
    },
    gba: {
      title: d.gba.title,
      game_code: d.gba.gameCode,
      maker: d.gba.maker,
      version: d.gba.version,
      header_checksum: d.gba.checksum,
      checksum_ok: d.gba.checksumOk,
      logo_ok: d.gba.logoOk,
      rom_size: d.rom.length,
      trimmed_trailing_ff: trimmed,
      download_size: outSize,
    },
    caa: {
      magic: d.caa.magicOk ? ".CAA" : null,
      version: d.caa.version,
      rom_size: d.caa.romSize,
      rom_size_trusted: d.romSizeFieldTrusted,
      save_type: d.caa.save.id,
      save_type_name: d.caa.save.name,
      save_alias: d.caa.save.alias,
      save_bytes: d.caa.save.bytes,
      rtc: d.caa.save.rtc,
      lcd_ghosting: d.caa.lcdGhosting,
      sleep_combo: d.caa.sleepCombo,
      flash_eeprom_config_hex: d.caa.flashConfigHex,
      descriptor_offset: d.caa.descriptorOffset,
      descriptor_count_shifted: d.caa.descriptorCountShifted,
      video_lut_hex: lut,
      footer_hex: hexBytes(d.caa.footer).replace(/ /g, ""),
    },
    smdh: d.smdh,
  };
  return JSON.stringify(body, null, 2);
}
