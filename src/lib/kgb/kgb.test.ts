import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KGB_PY = fileURLToPath(new URL("../../../public/kgb.py", import.meta.url));
import { parseCia, parseGbFile } from "./parse.ts";
import { decodeRgb565Icon, encodeRgb565Icon } from "./smdh.ts";
import { buildSyntheticCia, buildSyntheticGbCia, buildSyntheticGbRom, buildSyntheticRom, syntheticIconRgba } from "./synthetic.ts";
import { sanitizeFile, trimTrailingFf } from "./format.ts";
import { describeGbaSize } from "./validate.ts";
import { gbaHeaderChecksum, readGbaHeader } from "./gba.ts";
import { readGbHeader } from "./gb.ts";
import { buildGoombaGba } from "./goomba.ts";
import { blzDecompress } from "./blz.ts";
import { crc16 } from "./crc16.ts";
import { glyphRows5x7 } from "./font5x7.ts";
import { CARRIER_README, NDS_LOGO, installBannerIcon, packGbaAsNds, parseNds, runArm9Blit, squareImage } from "./nds.ts";
import { FRAME_BYTES } from "./screen.ts";

test("synthetic CIA round-trips to the planted ROM", () => {
  const cia = buildSyntheticCia();
  const dossier = parseCia(Uint8Array.from(cia).buffer, "KGB-SYNTHETIC.cia");
  const rom = buildSyntheticRom();
  assert.deepEqual(dossier.rom, rom);
  assert.equal(dossier.preambleBytes, 0x2000);
  assert.equal(dossier.gba.gameCode, "KGBE");
  assert.equal(dossier.gba.title, "KGB DOSSIER");
  assert.equal(dossier.gba.checksumOk, true);
  assert.equal(dossier.caa.save.id, 0x04);
  assert.equal(dossier.caa.save.rtc, true);
  assert.equal(dossier.caa.lcdGhosting, 0x10);
  assert.equal(dossier.caa.magicOk, true);
  assert.equal(dossier.romSizeFieldTrusted, true);
  assert.equal(dossier.encrypted, false);
  assert.equal(dossier.titleId, "0004800F004B4742");
  assert.equal(dossier.smdh?.short, "KGB TEST");
  assert.equal(dossier.smdh?.language, "English");
  assert.ok(dossier.iconRgba);
  const border = dossier.iconRgba;
  assert.ok(border[0]! > 180 && border[1]! > 140);
  const stamp = (24 * 48 + 16) * 4;
  assert.ok(border[stamp]! > 160 && border[stamp + 1]! < 100);
  const trimmed = trimTrailingFf(rom);
  assert.ok(trimmed.trimmed > 0 && trimmed.trimmed < rom.length);
});

test("SMDH icon survives Morton encode", () => {
  const rgba = syntheticIconRgba();
  const back = decodeRgb565Icon(encodeRgb565Icon(rgba, 48), 48);
  const i = (24 * 48 + 16) * 4;
  assert.ok(Math.abs(back[i]! - rgba[i]!) < 12);
  assert.ok(Math.abs(back[0]! - rgba[0]!) < 12);
});

test("python CLI extracts the TypeScript synthetic CIA", () => {
  const cia = buildSyntheticCia();
  const dir = mkdtempSync(join(tmpdir(), "kgb-"));
  const ciaPath = join(dir, "sample.cia");
  writeFileSync(ciaPath, cia);
  execFileSync("python3", [KGB_PY, ciaPath, "-o", dir], { encoding: "utf8" });
  const extracted = readFileSync(join(dir, "KGB DOSSIER [KGBE].gba"));
  assert.equal(Buffer.compare(extracted, Buffer.from(buildSyntheticRom())), 0);
  const report = JSON.parse(readFileSync(join(dir, "KGB DOSSIER [KGBE].caa.json"), "utf8"));
  assert.equal(report.caa.save_type, 4);
  assert.equal(report.caa.rtc, true);
  assert.equal(report.preamble_bytes, 0x2000);
});

test("TypeScript parses a Python synthetic CIA", () => {
  const dir = mkdtempSync(join(tmpdir(), "kgb-py-"));
  const ciaPath = join(dir, "py.cia");
  execFileSync("python3", [KGB_PY, "--synth", ciaPath]);
  const buf = readFileSync(ciaPath);
  const dossier = parseCia(Uint8Array.from(buf).buffer, "py.cia");
  assert.equal(dossier.gba.gameCode, "KGBE");
  assert.equal(dossier.preambleBytes, 0x2000);
  assert.equal(dossier.caa.save.rtc, true);
  assert.equal(dossier.smdh?.publisher, "KGB ARCHIVES");
});

test("BLZ round-trip matches python", () => {
  const pyPath = KGB_PY.replace(/\\/g, "/");
  const pyCmd = `import importlib.util; p=importlib.util.spec_from_file_location('kgb','${pyPath}'); m=importlib.util.module_from_spec(p); p.loader.exec_module(m); import sys; sys.stdout.buffer.write(m.blz_compress_literals(b'KGB!'*64))`;
  const compressed = execFileSync("python3", ["-c", pyCmd]);
  const out = blzDecompress(new Uint8Array(compressed));
  assert.equal(new TextDecoder().decode(out), "KGB!".repeat(64));
});

test("NDS logo CRC is the BIOS constant", () => {
  assert.equal(NDS_LOGO.length, 156);
  assert.equal(crc16(NDS_LOGO), 0xcf56);
});

test("GBA packs into an NDS carrier and extracts byte-for-byte", () => {
  const rom = new Uint8Array(buildSyntheticRom());
  const bigger = new Uint8Array(rom.length + 80);
  bigger.set(rom);
  bigger[bigger.length - 1] = 0x5a;
  const nds = packGbaAsNds({ rom: bigger, iconRgba: syntheticIconRgba() });
  const info = parseNds(nds, "carrier.nds");
  assert.equal(info.headerCrcOk, true);
  assert.equal(info.logoCrcOk, true);
  assert.equal(info.gameCode, "KGBE");
  assert.equal(info.title, "KGB DOSSIER");
  assert.equal(info.bannerTitle.includes("KGB DOSSIER"), true);
  assert.equal(info.files.length, 2);
  assert.ok(info.gba);
  assert.equal(info.gba.name, "rom.gba");
  assert.deepEqual(info.gba.rom, bigger);
  const readme = info.files.find((file) => file.name === "readme.txt");
  assert.ok(readme);
  const text = new TextDecoder().decode(nds.subarray(readme.start, readme.start + readme.size));
  assert.equal(text, CARRIER_README);
  assert.ok(info.iconRgba);
  assert.equal(info.iconRgba[3], 255);
  assert.ok(info.iconRgba[0]! > 140);

  const arm9Off = nds[0x20]! | (nds[0x21]! << 8) | (nds[0x22]! << 16) | (nds[0x23]! << 24);
  const arm9Size = nds[0x2c]! | (nds[0x2d]! << 8) | (nds[0x2e]! << 16) | (nds[0x2f]! << 24);
  const shown = runArm9Blit(nds.subarray(arm9Off, arm9Off + arm9Size));
  const codeBytes = arm9Size - FRAME_BYTES * 2;
  assert.deepEqual(shown.top, nds.subarray(arm9Off + codeBytes, arm9Off + codeBytes + FRAME_BYTES));
  assert.deepEqual(
    shown.bottom,
    nds.subarray(arm9Off + codeBytes + FRAME_BYTES, arm9Off + codeBytes + FRAME_BYTES * 2),
  );
  const border = shown.top[0]! | (shown.top[1]! << 8);
  const ink = shown.top[(170 * 256 + 240) * 2]! | (shown.top[(170 * 256 + 240) * 2 + 1]! << 8);
  assert.notEqual(border, ink);
});

test("a native NDS image is not turned into a fake GBA ROM", () => {
  const nds = packGbaAsNds({ rom: buildSyntheticRom() });
  const stripped = new Uint8Array(nds);
  stripped[0x44] = 0;
  stripped[0x45] = 0;
  const info = parseNds(stripped, "native.nds");
  assert.equal(info.gba, null);
  assert.equal(info.headerCrcOk, false);
  assert.ok(info.warnings.some((line) => line.includes("cannot be turned")));
});

function solidImage(r: number, g: number, b: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

test("a picture can be written into the NDS header banner", () => {
  const rom = buildSyntheticRom();
  const plain = packGbaAsNds({ rom });
  const withIcon = packGbaAsNds({
    rom,
    bannerImage: { rgba: syntheticIconRgba(), width: 48, height: 48 },
  });
  const plainInfo = parseNds(plain, "seal.nds");
  const iconInfo = parseNds(withIcon, "icon.nds");
  assert.equal(iconInfo.headerCrcOk, true);
  assert.equal(iconInfo.bannerOffset, plainInfo.bannerOffset);
  assert.ok(iconInfo.iconRgba);
  assert.ok(plainInfo.iconRgba);
  const at = (x: number, y: number) => (y * 32 + x) * 4;
  assert.ok(iconInfo.iconRgba[at(0, 0) + 1]! > 120);
  assert.ok(iconInfo.iconRgba[at(10, 14)]! > 140);
  assert.ok(iconInfo.iconRgba[at(10, 14) + 1]! < 110);
  assert.ok(plainInfo.iconRgba[at(10, 14)]! < 80);

  const stripped = new Uint8Array(plain);
  stripped[0x68] = 0;
  stripped[0x69] = 0;
  stripped[0x6a] = 0;
  stripped[0x6b] = 0;
  const crc = crc16(stripped, 0, 0x15e);
  stripped[0x15e] = crc & 0xff;
  stripped[0x15f] = (crc >> 8) & 0xff;
  const patched = installBannerIcon(stripped, { rgba: solidImage(220, 16, 16), width: 16, height: 16 });
  assert.ok(patched.length > stripped.length);
  const info = parseNds(patched, "added.nds");
  assert.equal(info.headerCrcOk, true);
  assert.ok(info.bannerOffset >= stripped.length);
  assert.ok(info.iconRgba);
  assert.ok(info.iconRgba[0]! > 180);
  assert.ok(info.iconRgba[1]! < 80);
  assert.deepEqual(info.gba?.rom, rom);

  const replaced = installBannerIcon(withIcon, { rgba: solidImage(16, 200, 32), width: 16, height: 16 });
  assert.equal(replaced.length, withIcon.length);
  const again = parseNds(replaced, "replaced.nds");
  assert.equal(again.headerCrcOk, true);
  assert.equal(again.bannerOffset, iconInfo.bannerOffset);
  assert.ok(again.iconRgba);
  assert.ok(again.iconRgba[1]! > 150);
    assert.deepEqual(again.gba?.rom, rom);
});

test("shared 5x7 font covers the NDS stamp charset", () => {
  for (const ch of "GBAX0123456789") {
    const rows = glyphRows5x7(ch);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((r) => r >= 0 && r <= 0b11111));
  }
  // Unknown glyphs fall back to the box, matching the old NDS behavior.
  assert.deepEqual(glyphRows5x7("€"), glyphRows5x7("~"));
});

test("header checksum accepts an explicit offset", () => {
  const rom = buildSyntheticRom();
  const padded = new Uint8Array(rom.length + 0x2000);
  padded.set(rom, 0x2000);
  assert.equal(gbaHeaderChecksum(padded, 0x2000), gbaHeaderChecksum(rom));
});

test("trim keeps ROMs with no trailing FF intact", () => {
  const dense = new Uint8Array(0xc0).fill(0x11);
  const { bytes, trimmed } = trimTrailingFf(dense);
  assert.equal(trimmed, 0);
  assert.equal(bytes.length, dense.length);
  // A ROM that is all padding except the header is left at the header floor.
  const tiny = new Uint8Array(0xd0).fill(0xff);
  assert.equal(trimTrailingFf(tiny).bytes.length, 0xc0);
});

test("sanitizeFile never splits a surrogate pair", () => {
  const name = sanitizeFile("ポケットモンスター エメラルド".repeat(10));
  assert.ok(name.length <= 80);
  assert.ok(!/\uFFFD/.test(name));
  assert.equal(sanitizeFile(""), "extracted");
  assert.equal(sanitizeFile("a/b\\c:d"), "a b c d");
});

test("squareImage rejects non-square and tiny buffers", () => {
  assert.equal(squareImage(null), null);
  assert.equal(squareImage(new Uint8ClampedArray(10)), null);
  const rect = new Uint8ClampedArray(8 * 16 * 4);
  assert.equal(squareImage(rect), null);
  const ok = squareImage(new Uint8ClampedArray(8 * 8 * 4));
  assert.equal(ok?.width, 8);
});

test("packing rejects files smaller than a GBA header", () => {
  assert.throws(() => packGbaAsNds({ rom: new Uint8Array(0xbf) }), /too small/);
});

test("NATIVE banner v2/v3 CRCs are verified", () => {
  const nds = packGbaAsNds({ rom: buildSyntheticRom() });
  const info = parseNds(nds, "carrier.nds");
  assert.equal(info.bannerVersion, 1);
  assert.equal(info.bannerCrcOk, true);
  assert.ok(info.arm9Size > 0 && info.arm7Size > 0);
  assert.ok(info.fntSize > 0 && info.fatSize > 0);
});

test("installBannerIcon rejects non-NDS input", () => {
  assert.throws(
    () => installBannerIcon(buildSyntheticRom(), { rgba: syntheticIconRgba(), width: 48, height: 48 }),
    /Not an NDS cartridge/,
  );
});

test("describeGbaSize distinguishes licensed, overdump, and non-standard sizes", () => {
  assert.equal(describeGbaSize(4 * 1024 * 1024).ok, true);
  assert.equal(describeGbaSize(4 * 1024 * 1024).detail, "Licensed cartridge size");
  assert.equal(describeGbaSize(32 * 1024 * 1024).ok, true);
  assert.equal(describeGbaSize(32 * 1024 * 1024).detail, "Licensed cartridge size");
  assert.equal(describeGbaSize(64 * 1024 * 1024).ok, false);
  assert.ok(describeGbaSize(64 * 1024 * 1024).detail.includes("overdump"));
  assert.equal(describeGbaSize(256).ok, true);
  assert.ok(describeGbaSize(256).detail.includes("trimmed or homebrew size"));
});

test("Game Boy VC CIA extracts GB ROM from RomFS", () => {
  const cia = buildSyntheticGbCia("KIRBY DREAM2", false);
  const dossier = parseCia(Uint8Array.from(cia).buffer, "Kirby's Dream Land 2.cia");
  assert.equal(dossier.system, "gb");
  assert.equal(dossier.rom.length, 32768);
  assert.ok(dossier.gb);
  assert.equal(dossier.gb.title, "KIRBY DREAM2");
  assert.equal(dossier.gb.cartridgeTypeName, "MBC1+RAM+BATTERY");
  assert.equal(dossier.gb.checksumOk, true);
  assert.equal(dossier.gb.logoOk, true);
  assert.equal(dossier.gb.cgbOnly, false);
});

test("Game Boy Color VC CIA extracts GBC ROM from RomFS", () => {
  const cia = buildSyntheticGbCia("POKEMON CRYS", true);
  const dossier = parseCia(Uint8Array.from(cia).buffer, "Pokemon Crystal.cia");
  assert.equal(dossier.system, "gbc");
  assert.ok(dossier.gb);
  assert.equal(dossier.gb.cgbOnly, true);
  assert.equal(dossier.gb.cgbSupported, true);
  assert.equal(dossier.gb.checksumOk, true);
});

test("parseGbFile parses a standalone .gb ROM", () => {
  const rom = buildSyntheticGbRom("ZELDA LA", false);
  const dossier = parseGbFile(rom.buffer, "zelda.gb");
  assert.equal(dossier.system, "gb");
  assert.equal(dossier.rom.length, 32768);
  assert.equal(dossier.gb?.title, "ZELDA LA");
  assert.equal(dossier.gb?.checksumOk, true);
});

test("Goomba Color bundles GB ROM into playable GBA image", () => {
  const goombaPath = fileURLToPath(new URL("../../../public/goomba.gba", import.meta.url));
  const goombaBase = new Uint8Array(readFileSync(goombaPath));
  const gbRom = buildSyntheticGbRom("KIRBY DREAM2", false);
  const gba = buildGoombaGba(goombaBase, gbRom, "KIRBY DREAM2");
  assert.equal(gba.length, goombaBase.length + gbRom.length);
  const header = readGbaHeader(gba);
  assert.equal(header.title, "KIRBYDREAM2");
  assert.equal(header.checksumOk, true);
  assert.equal(header.logoOk, true);
});
