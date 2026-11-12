import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCia } from "./parse.ts";
import { decodeRgb565Icon, encodeRgb565Icon } from "./smdh.ts";
import { buildSyntheticCia, buildSyntheticRom, syntheticIconRgba } from "./synthetic.ts";
import { trimTrailingFf } from "./format.ts";
import { blzDecompress } from "./blz.ts";
import { crc16 } from "./crc16.ts";
import { CARRIER_README, NDS_LOGO, installBannerIcon, packGbaAsNds, parseNds, runArm9Blit } from "./nds.ts";
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
  execFileSync("python3", ["/workspace/public/kgb.py", ciaPath, "-o", dir], { encoding: "utf8" });
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
  execFileSync("python3", ["/workspace/public/kgb.py", "--synth", ciaPath]);
  const buf = readFileSync(ciaPath);
  const dossier = parseCia(Uint8Array.from(buf).buffer, "py.cia");
  assert.equal(dossier.gba.gameCode, "KGBE");
  assert.equal(dossier.preambleBytes, 0x2000);
  assert.equal(dossier.caa.save.rtc, true);
  assert.equal(dossier.smdh?.publisher, "KGB ARCHIVES");
});

test("BLZ round-trip matches python", () => {
  const compressed = execFileSync("python3", ["-c", "import importlib.util; p=importlib.util.spec_from_file_location('kgb','/workspace/public/kgb.py'); m=importlib.util.module_from_spec(p); p.loader.exec_module(m); import sys; sys.stdout.buffer.write(m.blz_compress_literals(b'KGB!'*64))"]);
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

