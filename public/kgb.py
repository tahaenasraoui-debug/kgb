#!/usr/bin/env python3
"""KGB — Kernel GBA Boy.

Extract a bit-perfect .gba ROM from a Nintendo 3DS GBA Virtual Console .cia.
Strips the AGB_FIRM boot preamble and the 0x360-byte .CAA footer, and writes
the SMDH icon plus footer JSON. Python 3 stdlib only.

  kgb.py game.cia [-o DIR] [--trim-ff]
  kgb.py --synth sample.cia
  kgb.py --self-test
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

GBA_LOGO_16 = bytes(
    [0x24, 0xFF, 0xAE, 0x51, 0x69, 0x9A, 0xA2, 0x21, 0x3D, 0x84, 0x82, 0x0A, 0x84, 0xE4, 0x09, 0xAD]
)
SYNTH_ROM_SIZE = 0x400
SYNTH_PREAMBLE = 0x2000
SYNTH_SAVE = 0x04
SYNTH_GHOST = 0x10
SYNTH_SLEEP = 0x00FE

SAVE_TYPES = {
    0x00: ("EEPROM 512 bytes", False, 512, "4 Kbit · <256 Mbit ROM"),
    0x01: ("EEPROM 512 bytes", False, 512, "4 Kbit · 256 Mbit ROM"),
    0x02: ("EEPROM 8 KiB", False, 8192, "64 Kbit · <256 Mbit ROM"),
    0x03: ("EEPROM 8 KiB", False, 8192, "64 Kbit · 256 Mbit ROM"),
    0x04: ("FLASH 64 KiB Atmel + RTC", True, 65536, "512 Kbit · ID 3D1F"),
    0x05: ("FLASH 64 KiB Atmel", False, 65536, "512 Kbit · ID 3D1F"),
    0x06: ("FLASH 64 KiB SST + RTC", True, 65536, "512 Kbit · ID D4BF"),
    0x07: ("FLASH 64 KiB SST", False, 65536, "512 Kbit · ID D4BF"),
    0x08: ("FLASH 64 KiB Panasonic + RTC", True, 65536, "512 Kbit · ID 1B32"),
    0x09: ("FLASH 64 KiB Panasonic", False, 65536, "512 Kbit · ID 1B32"),
    0x0A: ("FLASH 128 KiB Macronix + RTC", True, 131072, "1 Mbit · ID 09C2"),
    0x0B: ("FLASH 128 KiB Macronix", False, 131072, "1 Mbit · ID 09C2"),
    0x0C: ("FLASH 128 KiB Sanyo + RTC", True, 131072, "1 Mbit · ID 1362"),
    0x0D: ("FLASH 128 KiB Sanyo", False, 131072, "1 Mbit · ID 1362"),
    0x0E: ("SRAM / FRAM 32 KiB", False, 32768, "256 Kbit"),
}


class KgbError(Exception):
    pass


def align64(x: int) -> int:
    return (x + 0x3F) & ~0x3F


def align_up(n: int, a: int) -> int:
    return (n + (a - 1)) & ~(a - 1)


def u32(buf: bytes, off: int) -> int:
    return struct.unpack_from("<I", buf, off)[0]


def put_u32(buf: bytearray, off: int, value: int) -> None:
    struct.pack_into("<I", buf, off, value & 0xFFFFFFFF)


def put_u16(buf: bytearray, off: int, value: int) -> None:
    struct.pack_into("<H", buf, off, value & 0xFFFF)


def ascii_field(buf: bytes, start: int, length: int) -> str:
    raw = buf[start : start + length]
    end = raw.find(b"\x00")
    if end >= 0:
        raw = raw[:end]
    return "".join(chr(b) for b in raw if 0x20 <= b < 0x7F).strip()


def describe_save(save_id: int) -> dict:
    known = SAVE_TYPES.get(save_id)
    if known is None:
        return {"id": save_id, "name": "No save chip", "rtc": False, "bytes": None, "alias": "AGB_FIRM stores nothing"}
    name, rtc, nbytes, alias = known
    return {"id": save_id, "name": name, "rtc": rtc, "bytes": nbytes, "alias": alias}


def gba_header_checksum(header: bytes) -> int:
    chk = 0
    for i in range(0xA0, 0xBD):
        chk = (chk - header[i]) & 0xFF
    return (chk - 0x19) & 0xFF


def logo_at(code: bytes, off: int) -> bool:
    if off < 0 or off + 0xBE > len(code):
        return False
    if code[off + 0x04 : off + 0x14] != GBA_LOGO_16:
        return False
    if code[off + 0xB2] != 0x96:
        return False
    return code[off + 0xBD] == gba_header_checksum(code[off : off + 0xC0])


def find_rom_start(code: bytes) -> int | None:
    if logo_at(code, 0):
        return 0
    if logo_at(code, 0x2000):
        return 0x2000
    limit = len(code) - 0xBE
    off = 4
    while off <= limit:
        if off != 0x2000 and code[off + 0x04] == 0x24 and logo_at(code, off):
            return off
        off += 4
    return None


def find_caa_footer(code: bytes) -> tuple[int, bool] | None:
    fallback: tuple[int, bool] | None = None
    i = len(code) - 4
    while i >= 0x350:
        if code[i : i + 4] == b".CAA":
            start = i - 0x350
            if start + 0x360 <= len(code):
                rom_size = u32(code, start + 0x04)
                version = u32(code, start + 0x354)
                near_end = len(code) - (start + 0x360) <= 0x1000
                sane = 0xC0 <= rom_size <= start
                if version == 1 and sane and near_end:
                    return start, True
                if fallback is None and sane:
                    fallback = (start, True)
        i -= 1
    if fallback:
        return fallback
    if len(code) >= 0x360:
        return len(code) - 0x360, False
    return None


def blz_decompress(data: bytes) -> bytes:
    if len(data) < 8:
        raise KgbError("BLZ payload is shorter than the 8-byte footer.")
    header = u32(data, len(data) - 8)
    extra = u32(data, len(data) - 4)
    compressed_size = header & 0x00FFFFFF
    footer_size = header >> 24
    if footer_size < 8 or compressed_size < footer_size or compressed_size > len(data):
        raise KgbError("BLZ footer is not plausible.")
    if extra > 64 * 1024 * 1024 or len(data) + extra > 64 * 1024 * 1024:
        raise KgbError("BLZ output is unreasonably large.")
    out = bytearray(len(data) + extra)
    out[: len(data)] = data
    src = len(data) - footer_size
    dst = len(out)
    end = len(data) - compressed_size
    while src > end:
        src -= 1
        flags = out[src]
        for _ in range(8):
            if src <= end:
                break
            if flags & 0x80:
                if src < end + 2:
                    raise KgbError("BLZ stream truncated inside a back-reference.")
                src -= 1
                b1 = out[src]
                src -= 1
                b2 = out[src]
                length = (b1 >> 4) + 3
                disp = (((b1 & 0x0F) << 8) | b2) + 3
                for _j in range(length):
                    dst -= 1
                    if dst < 0 or dst + disp >= len(out):
                        raise KgbError("BLZ back-reference walked out of range.")
                    out[dst] = out[dst + disp]
            else:
                src -= 1
                dst -= 1
                if dst < 0 or src < 0:
                    raise KgbError("BLZ literal walked out of range.")
                out[dst] = out[src]
            flags = (flags << 1) & 0xFF
    return bytes(out)


def morton8(i: int) -> tuple[int, int]:
    x = (i & 1) | ((i & 4) >> 1) | ((i & 16) >> 2)
    y = ((i & 2) >> 1) | ((i & 8) >> 2) | ((i & 32) >> 3)
    return x, y


def decode_rgb565_icon(src: bytes, size: int = 48) -> bytes:
    rgba = bytearray(size * size * 4)
    tiles = size // 8
    o = 0
    for tile in range(tiles * tiles):
        tile_x = tile % tiles
        tile_y = tile // tiles
        for p in range(64):
            x, y = morton8(p)
            pix = src[o] | (src[o + 1] << 8)
            o += 2
            r = round(((pix >> 11) & 0x1F) * (255 / 31))
            g = round(((pix >> 5) & 0x3F) * (255 / 63))
            b = round((pix & 0x1F) * (255 / 31))
            di = ((tile_y * 8 + y) * size + (tile_x * 8 + x)) * 4
            rgba[di : di + 4] = bytes((r, g, b, 255))
    return bytes(rgba)


def encode_rgb565_icon(rgba: bytes, size: int = 48) -> bytes:
    out = bytearray(size * size * 2)
    tiles = size // 8
    o = 0
    for tile in range(tiles * tiles):
        tile_x = tile % tiles
        tile_y = tile // tiles
        for p in range(64):
            x, y = morton8(p)
            di = ((tile_y * 8 + y) * size + (tile_x * 8 + x)) * 4
            r, g, b = rgba[di], rgba[di + 1], rgba[di + 2]
            pix = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            out[o] = pix & 0xFF
            out[o + 1] = (pix >> 8) & 0xFF
            o += 2
    return bytes(out)


def utf16le(data: bytes, start: int, nbytes: int) -> str:
    raw = data[start : start + nbytes]
    chars = []
    for i in range(0, len(raw) - 1, 2):
        c = raw[i] | (raw[i + 1] << 8)
        if c == 0:
            break
        chars.append(chr(c))
    return "".join(chars).strip()


def parse_smdh(data: bytes) -> tuple[dict, bytes] | None:
    if len(data) < 4 or data[:4] != b"SMDH":
        return None
    langs = [
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
    ]
    chosen = {"language": "—", "short": "", "long": "", "publisher": ""}
    for idx in (1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11):
        base = 0x8 + idx * 0x200
        if base + 0x200 > len(data):
            break
        short = utf16le(data, base, 0x80)
        long = utf16le(data, base + 0x80, 0x100)
        publisher = utf16le(data, base + 0x180, 0x80)
        if short or long or publisher:
            chosen = {"language": langs[idx], "short": short, "long": long, "publisher": publisher}
            break
    icon = b""
    if len(data) >= 0x24C0 + 0x1200:
        icon = decode_rgb565_icon(data[0x24C0 : 0x24C0 + 0x1200], 48)
    return chosen, icon


def trim_ff(rom: bytes) -> bytes:
    end = len(rom)
    while end > 0xC0 and rom[end - 1] == 0xFF:
        end -= 1
    return rom[:end]


def sanitize(name: str) -> str:
    cleaned = "".join(" " if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in name)
    cleaned = " ".join(cleaned.split()).strip()
    return (cleaned[:80] or "extracted")


def read_exefs_name(data: bytes, off: int) -> str:
    raw = data[off : off + 8]
    end = raw.find(b"\x00")
    if end >= 0:
        raw = raw[:end]
    return raw.decode("ascii", "replace")


def parse_cia(data: bytes) -> dict:
    warnings: list[str] = []
    if len(data) < 0x200:
        raise KgbError("File is too small to be a CIA or NCCH.")
    if data[0x100:0x104] == b"NCCH":
        ncch = 0
        cert_size = ticket_size = tmd_size = meta_size = content_size = 0
        warnings.append("Input is a bare NCCH/CXI, not a CIA wrapper.")
    else:
        header_size = u32(data, 0x00)
        cert_size = u32(data, 0x08)
        ticket_size = u32(data, 0x0C)
        tmd_size = u32(data, 0x10)
        meta_size = u32(data, 0x14)
        content_size = struct.unpack_from("<Q", data, 0x18)[0]
        if header_size < 0x20 or header_size > len(data):
            raise KgbError(f"CIA header size {header_size} is not plausible.")
        ncch = align64(header_size) + align64(cert_size) + align64(ticket_size) + align64(tmd_size)
    if ncch + 0x200 > len(data) or data[ncch + 0x100 : ncch + 0x104] != b"NCCH":
        raise KgbError("NCCH magic not found. This is not an unwrapped GBA VC CIA.")
    title_id = f"{u32(data, ncch + 0x11C):08X}{u32(data, ncch + 0x118):08X}"
    product = ascii_field(data, ncch + 0x150, 16)
    encrypted = (data[ncch + 0x18F] & 0x04) == 0
    if encrypted:
        warnings.append("NCCH NoCrypto flag is clear. Payload is probably still encrypted.")
    exefs_media = u32(data, ncch + 0x1A0)
    exefs = ncch + exefs_media * 0x200
    romfs_media = u32(data, ncch + 0x1B0) if ncch + 0x1B4 <= len(data) else 0
    code_compressed = False
    if ncch + 0x200 + 0x0D < exefs and ncch + 0x20D < len(data):
        code_compressed = (data[ncch + 0x20D] & 0x01) != 0
    if exefs_media == 0 or exefs + 0x200 > len(data):
        raise KgbError("ExeFS offset is missing or points outside the file.")
    names: list[str] = []
    code_off = code_size = icon_off = icon_size = -1
    for i in range(10):
        ent = exefs + i * 16
        name = read_exefs_name(data, ent)
        names.append(name)
        if not name:
            continue
        off = u32(data, ent + 8)
        size = u32(data, ent + 12)
        abs_off = exefs + 0x200 + off
        if name in (".code", "code"):
            code_off, code_size = abs_off, size
        elif name == "icon":
            icon_off, icon_size = abs_off, size
    if code_off < 0 or code_size <= 0:
        raise KgbError("ExeFS has no .code file.")
    if code_off + code_size > len(data):
        raise KgbError(".code extends past the end of the file.")
    code = data[code_off : code_off + code_size]
    if code_compressed:
        try:
            code = blz_decompress(code)
            warnings.append("ExeFS .code was BLZ-compressed and has been decompressed.")
        except KgbError as exc:
            warnings.append(f"BLZ failed ({exc}). Scanning raw .code.")
    rom_start = find_rom_start(code)
    if rom_start is None:
        if romfs_media > 0:
            raise KgbError("No GBA cartridge header in .code. This CIA contains a RomFS partition (likely a GB/GBC, NES, or SNES emulator inject, not a GBA AGB_FIRM inject).")
        raise KgbError("No GBA cartridge header in .code.")
    found = find_caa_footer(code)
    if found is None:
        raise KgbError(".code is too small to contain a .CAA footer.")
    footer_start, trusted_magic = found
    if not trusted_magic:
        warnings.append("'.CAA' magic was not found. Using the last 0x360 bytes.")
    footer = code[footer_start : footer_start + 0x360]
    rom_size = u32(footer, 0x04)
    rom_end = rom_start + rom_size
    trusted = True
    if not (rom_size >= 0xC0 and rom_start < rom_end <= footer_start):
        trusted = False
        rom_end = footer_start
        warnings.append("Footer rom_size is not usable. Slicing from the header to the footer.")
    rom = code[rom_start:rom_end]
    gba = {
        "title": ascii_field(rom, 0xA0, 12),
        "game_code": ascii_field(rom, 0xAC, 4),
        "maker": ascii_field(rom, 0xB0, 2),
        "version": rom[0xBC] if len(rom) > 0xBC else 0,
        "checksum": gba_header_checksum(rom) if len(rom) >= 0xBE else 0,
        "checksum_ok": len(rom) > 0xBD and rom[0xB2] == 0x96 and rom[0xBD] == gba_header_checksum(rom),
        "logo_ok": rom[0x04:0x14] == GBA_LOGO_16,
    }
    smdh = None
    icon = b""
    if icon_off >= 0 and icon_size > 0 and icon_off + icon_size <= len(data):
        parsed = parse_smdh(data[icon_off : icon_off + icon_size])
        if parsed:
            smdh, icon = parsed
        else:
            warnings.append("ExeFS icon is not an SMDH.")
    else:
        warnings.append("No SMDH icon in ExeFS.")
    save = describe_save(u32(footer, 0x08))
    return {
        "warnings": warnings,
        "title_id": title_id,
        "product_code": product,
        "encrypted": encrypted,
        "offsets": {
            "cia_header": 0,
            "ncch": ncch,
            "exefs": exefs,
            "code_in_file": code_off,
            "agb_firm_preamble_in_code": 0,
            "gba_rom_start_in_code": rom_start,
            "caa_footer_in_code": footer_start,
            "rom_in_file": code_off + rom_start,
            "smdh_icon_in_file": icon_off,
            "cert_size": cert_size,
            "ticket_size": ticket_size,
            "tmd_size": tmd_size,
            "meta_size": meta_size,
            "content_size": content_size,
        },
        "preamble_bytes": rom_start,
        "gba": gba,
        "rom": rom,
        "rom_size_trusted": trusted,
        "footer": footer,
        "caa": {
            "magic": ".CAA" if trusted_magic else None,
            "version": u32(footer, 0x354),
            "rom_size": rom_size,
            "rom_size_trusted": trusted,
            "save_type": save["id"],
            "save_type_name": save["name"],
            "save_alias": save["alias"],
            "save_bytes": save["bytes"],
            "rtc": save["rtc"],
            "lcd_ghosting": u32(footer, 0x20),
            "sleep_combo": struct.unpack_from("<H", footer, 0x0E)[0],
            "flash_eeprom_config_hex": footer[0x10:0x20].hex().upper(),
            "descriptor_offset": u32(footer, 0x358),
            "descriptor_count_shifted": u32(footer, 0x35C),
            "video_lut_hex": footer[0x24 : 0x24 + 0x300].hex().upper(),
            "footer_hex": footer.hex().upper(),
        },
        "smdh": smdh,
        "icon": icon,
    }


def write_png(path: Path, rgba: bytes, w: int, h: int) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * w * 4 : (y + 1) * w * 4] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def synthetic_icon_rgba() -> bytes:
    rgba = bytearray(48 * 48 * 4)
    brass = bytes((0xD6, 0xB2, 0x5E, 255))
    ink = bytes((0x1A, 0x1C, 0x14, 255))
    stamp = bytes((0xC4, 0x45, 0x36, 255))
    paper = bytes((0xE6, 0xE1, 0xD3, 255))
    for y in range(48):
        for x in range(48):
            border = x < 2 or y < 2 or x >= 46 or y >= 46
            inner = 4 <= x < 44 and 4 <= y < 44 and (x < 6 or y < 6 or x >= 42 or y >= 42)
            bar = 20 <= y < 28 and 8 <= x < 40 and ((8 <= x < 14) or (18 <= x < 24) or (28 <= x < 40))
            mark = (not bar) and 16 <= y < 32 and 6 <= x < 42
            px = ink
            if border or inner:
                px = brass
            elif bar:
                px = paper
            elif mark:
                px = stamp
            i = (y * 48 + x) * 4
            rgba[i : i + 4] = px
    return bytes(rgba)


def _write_utf16(buf: bytearray, offset: int, byte_len: int, text: str) -> None:
    max_chars = byte_len // 2
    for i in range(max_chars):
        c = ord(text[i]) if i < len(text) else 0
        buf[offset + i * 2] = c & 0xFF
        buf[offset + i * 2 + 1] = (c >> 8) & 0xFF


def build_synthetic_rom() -> bytes:
    rom = bytearray(SYNTH_ROM_SIZE)
    rom[0x04:0x14] = GBA_LOGO_16
    rom[0xA0:0xAC] = b"KGB DOSSIER "
    rom[0xAC:0xB0] = b"KGBE"
    rom[0xB0:0xB2] = b"K1"
    rom[0xB2] = 0x96
    rom[0xBD] = gba_header_checksum(rom)
    for i in range(0x100, 0x3F0):
        rom[i] = (i * 17 + 3) & 0xFF
    rom[0x3F0:] = b"\xFF" * (SYNTH_ROM_SIZE - 0x3F0)
    return bytes(rom)


def build_lut() -> bytes:
    lut = bytearray(0x300)
    for i in range(256):
        lut[i * 3] = (i * 200) // 255
        lut[i * 3 + 1] = (i * 180) // 255
        lut[i * 3 + 2] = (i * 140) // 255
    return bytes(lut)


def build_caa(rom_size: int, code_before: int) -> bytes:
    footer = bytearray(0x360)
    put_u32(footer, 0x04, rom_size)
    put_u32(footer, 0x08, SYNTH_SAVE)
    put_u16(footer, 0x0C, 0xFFFF)
    put_u16(footer, 0x0E, SYNTH_SLEEP)
    footer[0x24 : 0x24 + 0x300] = build_lut()
    put_u32(footer, 0x20, SYNTH_GHOST)
    put_u32(footer, 0x330, 0)
    put_u32(footer, 0x334, 0)
    put_u32(footer, 0x338, rom_size)
    put_u32(footer, 0x340, 1)
    put_u32(footer, 0x344, code_before)
    put_u32(footer, 0x348, 0x324)
    footer[0x350:0x354] = b".CAA"
    put_u32(footer, 0x354, 1)
    put_u32(footer, 0x358, code_before + 0x330)
    put_u32(footer, 0x35C, 2 << 4)
    return bytes(footer)


def build_smdh() -> bytes:
    smdh = bytearray(0x36C0)
    smdh[0:4] = b"SMDH"
    for idx in (0, 1):
        base = 0x8 + idx * 0x200
        _write_utf16(smdh, base, 0x80, "KGB TEST")
        _write_utf16(smdh, base + 0x80, 0x100, "Kernel GBA Boy")
        _write_utf16(smdh, base + 0x180, 0x80, "KGB ARCHIVES")
    smdh[0x24C0 : 0x24C0 + 0x1200] = encode_rgb565_icon(synthetic_icon_rgba(), 48)
    return bytes(smdh)


def build_synthetic_cia() -> bytes:
    rom = build_synthetic_rom()
    preamble = bytearray(SYNTH_PREAMBLE)
    preamble[0:13] = b"AGB_FIRM BOOT"
    code_before = len(preamble) + len(rom)
    footer = build_caa(len(rom), code_before)
    code = preamble + rom + footer
    smdh = build_smdh()
    code_aligned = align_up(len(code), 0x200)
    exefs_body = code_aligned + len(smdh)
    exefs_total = align_up(0x200 + exefs_body, 0x200)
    exheader = bytearray(0x800)
    exheader[0:6] = b"KgbApp"
    ncch_head = 0x200
    exefs_media = (ncch_head + len(exheader)) // 0x200
    ncch_size = ncch_head + len(exheader) + exefs_total
    header_size, cert_size, ticket_size, tmd_size = 0x2020, 0x40, 0x40, 0x40
    ncch_off = align64(header_size) + cert_size + ticket_size + tmd_size
    file = bytearray(ncch_off + ncch_size)
    put_u32(file, 0x00, header_size)
    put_u32(file, 0x08, cert_size)
    put_u32(file, 0x0C, ticket_size)
    put_u32(file, 0x10, tmd_size)
    put_u32(file, 0x18, ncch_size)
    file[0x20] = 0x80
    file[align64(header_size) : align64(header_size) + 4] = b"CERT"
    file[align64(header_size) + cert_size : align64(header_size) + cert_size + 4] = b"TICK"
    base_tmd = align64(header_size) + cert_size + ticket_size
    file[base_tmd : base_tmd + 4] = b"TMD!"
    ncch = ncch_off
    file[ncch + 0x100 : ncch + 0x104] = b"NCCH"
    put_u32(file, ncch + 0x104, ncch_size // 0x200)
    put_u32(file, ncch + 0x108, 0x004B4742)
    put_u32(file, ncch + 0x10C, 0x0004800F)
    file[ncch + 0x110 : ncch + 0x112] = b"01"
    put_u32(file, ncch + 0x118, 0x004B4742)
    put_u32(file, ncch + 0x11C, 0x0004800F)
    file[ncch + 0x150 : ncch + 0x15A] = b"CTR-P-KGBE"
    put_u32(file, ncch + 0x180, 0x400)
    file[ncch + 0x18D] = 0x02
    file[ncch + 0x18F] = 0x04
    put_u32(file, ncch + 0x1A0, exefs_media)
    put_u32(file, ncch + 0x1A4, exefs_total // 0x200)
    put_u32(file, ncch + 0x1A8, 1)
    file[ncch + ncch_head : ncch + ncch_head + len(exheader)] = exheader
    exefs = ncch + ncch_head + len(exheader)
    file[exefs : exefs + 5] = b".code"
    put_u32(file, exefs + 8, 0)
    put_u32(file, exefs + 12, len(code))
    file[exefs + 16 : exefs + 20] = b"icon"
    put_u32(file, exefs + 24, code_aligned)
    put_u32(file, exefs + 28, len(smdh))
    file[exefs + 0x200 : exefs + 0x200 + len(code)] = code
    file[exefs + 0x200 + code_aligned : exefs + 0x200 + code_aligned + len(smdh)] = smdh
    return bytes(file)


def public_report(info: dict) -> dict:
    return {
        "tool": "KGB",
        "title_id": info["title_id"],
        "product_code": info["product_code"],
        "encrypted": info["encrypted"],
        "warnings": info["warnings"],
        "offsets": info["offsets"],
        "gba": {k: v for k, v in info["gba"].items()},
        "caa": info["caa"],
        "smdh": info["smdh"],
        "preamble_bytes": info["preamble_bytes"],
    }


def extract(path: Path, out_dir: Path, trim: bool) -> None:
    data = path.read_bytes()
    info = parse_cia(data)
    rom = trim_ff(info["rom"]) if trim else info["rom"]
    info["gba"]["rom_size"] = len(info["rom"])
    info["gba"]["download_size"] = len(rom)
    info["gba"]["trimmed_trailing_ff"] = trim and len(rom) != len(info["rom"])
    stem_title = sanitize(info["gba"]["title"] or "untitled")
    stem_code = sanitize(info["gba"]["game_code"] or "----")
    stem = f"{stem_title} [{stem_code}]"
    out_dir.mkdir(parents=True, exist_ok=True)
    gba_path = out_dir / f"{stem}.gba"
    json_path = out_dir / f"{stem}.caa.json"
    bin_path = out_dir / f"{stem}.caa.bin"
    gba_path.write_bytes(rom)
    report = public_report(info)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    bin_path.write_bytes(info["footer"])
    png_path = None
    if info["icon"]:
        png_path = out_dir / f"{stem}.png"
        write_png(png_path, info["icon"], 48, 48)
    print(f"title     {info['gba']['title']} [{info['gba']['game_code']}]")
    print(f"title id  {info['title_id']}")
    print(f"preamble  {info['preamble_bytes']} bytes")
    print(f"rom       {len(rom)} bytes -> {gba_path}")
    print(f"save      0x{info['caa']['save_type']:02X} {info['caa']['save_type_name']}  RTC {'yes' if info['caa']['rtc'] else 'no'}")
    print(f"footer    {json_path}")
    if png_path:
        print(f"icon      {png_path}")
    for warning in info["warnings"]:
        print(f"warn      {warning}", file=sys.stderr)


def self_test() -> None:
    cia = build_synthetic_cia()
    info = parse_cia(cia)
    rom = build_synthetic_rom()
    assert info["rom"] == rom, "synthetic ROM bytes diverged"
    assert info["preamble_bytes"] == SYNTH_PREAMBLE
    assert info["gba"]["game_code"] == "KGBE"
    assert info["gba"]["checksum_ok"]
    assert info["caa"]["save_type"] == SYNTH_SAVE and info["caa"]["rtc"] is True
    assert info["caa"]["lcd_ghosting"] == SYNTH_GHOST
    assert info["smdh"]["short"] == "KGB TEST"
    assert info["icon"][0] > 180  # brass border, R
    assert len(trim_ff(rom)) < len(rom)
    blob = blz_compress_literals(b"KGB!" * 64)
    assert blz_decompress(blob) == b"KGB!" * 64
    print("kgb.py self-test ok")


def blz_compress_literals(data: bytes) -> bytes:
    """Backward-LZ compressor used by --self-test. Literals and 3..18-byte matches."""
    tokens: list[tuple] = []
    pos = len(data)
    while pos > 0:
        best_len = 0
        best_disp = 0
        max_len = min(18, pos)
        if max_len >= 3:
            max_disp = min(0xFFF + 3, len(data) - (pos - max_len))
            disp = 3
            while disp <= max_disp:
                length = 0
                while length < max_len:
                    src_i = pos - 1 - length
                    dst_i = src_i + disp
                    if dst_i >= len(data) or data[src_i] != data[dst_i]:
                        break
                    length += 1
                if length > best_len and length >= 3:
                    best_len = length
                    best_disp = disp
                disp += 1
        if best_len >= 3:
            tokens.append(("ref", best_len, best_disp))
            pos -= best_len
        else:
            tokens.append(("lit", data[pos - 1]))
            pos -= 1
    stream_rev = bytearray()
    i = 0
    while i < len(tokens):
        group = tokens[i : i + 8]
        i += 8
        flag = 0
        payload = bytearray()
        for bit, tok in enumerate(group):
            if tok[0] == "ref":
                flag |= 0x80 >> bit
                length, disp = tok[1], tok[2]
                disp_enc = disp - 3
                b1 = ((length - 3) << 4) | ((disp_enc >> 8) & 0xF)
                b2 = disp_enc & 0xFF
                payload.append(b1)
                payload.append(b2)
            else:
                payload.append(tok[1])
        stream_rev.append(flag)
        stream_rev.extend(payload)
    stream = bytes(reversed(stream_rev))
    footer_size = 8
    compressed_size = len(stream) + footer_size
    if compressed_size > len(data) or compressed_size > 0xFFFFFF:
        raise KgbError("self-test payload did not shrink under BLZ")
    word = (footer_size << 24) | compressed_size
    addl = len(data) - compressed_size
    return stream + struct.pack("<II", word, addl)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kgb.py", description="Extract a GBA ROM from a 3DS GBA VC .cia")
    parser.add_argument("cia", nargs="?", type=Path, help="input .cia / .cxi")
    parser.add_argument("-o", "--out", type=Path, default=Path("."), help="output directory")
    parser.add_argument("--trim-ff", action="store_true", help="drop trailing 0xFF padding from the ROM")
    parser.add_argument("--synth", type=Path, help="write a synthetic test CIA and exit")
    parser.add_argument("--self-test", action="store_true", help="build a synthetic CIA and round-trip it")
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            self_test()
            return 0
        if args.synth:
            args.synth.write_bytes(build_synthetic_cia())
            print(f"wrote {args.synth} ({args.synth.stat().st_size} bytes)")
            return 0
        if args.cia is None:
            parser.print_help()
            return 2
        extract(args.cia, args.out, args.trim_ff)
        return 0
    except KgbError as exc:
        print(f"kgb: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
