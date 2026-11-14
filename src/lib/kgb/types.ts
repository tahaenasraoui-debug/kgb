import type { GbHeader } from "./gb.ts";

export type SystemKind = "gba" | "gb" | "gbc";

export type SaveInfo = {
  id: number;
  name: string;
  rtc: boolean;
  bytes: number | null;
  alias: string;
};

export type SmdhTitles = {
  language: string;
  short: string;
  long: string;
  publisher: string;
};

export type Offsets = {
  ciaHeader: number;
  certSize: number;
  ticketSize: number;
  tmdSize: number;
  metaSize: number;
  contentSize: number;
  ncch: number;
  exefs: number;
  codeInFile: number;
  iconInFile: number;
  preambleInCode: number;
  romStartInCode: number;
  footerInCode: number;
  romInFile: number;
};

export type GbaHeader = {
  title: string;
  gameCode: string;
  maker: string;
  version: number;
  checksum: number;
  checksumOk: boolean;
  logoOk: boolean;
};

export type CaaFooter = {
  romSize: number;
  save: SaveInfo;
  lcdGhosting: number;
  sleepCombo: number;
  flashConfigHex: string;
  videoLut: Uint8Array;
  version: number;
  descriptorOffset: number;
  descriptorCountShifted: number;
  magicOk: boolean;
  footer: Uint8Array;
};

export function makeEmptyCaa(): CaaFooter {
  return {
    romSize: 0,
    save: { id: 0, name: "None", rtc: false, bytes: 0, alias: "None" },
    lcdGhosting: 0,
    sleepCombo: 0,
    flashConfigHex: "",
    videoLut: new Uint8Array(0),
    version: 0,
    descriptorOffset: 0,
    descriptorCountShifted: 0,
    magicOk: false,
    footer: new Uint8Array(0),
  };
}

export type Dossier = {
  fileName: string;
  fileSize: number;
  system: SystemKind;
  titleId: string;
  productCode: string;
  encrypted: boolean;
  codeCompressed: boolean;
  decompressed: boolean;
  exefsNames: string[];
  offsets: Offsets;
  preambleBytes: number;
  gba: GbaHeader;
  gb?: GbHeader;
  caa: CaaFooter;
  rom: Uint8Array;
  romSizeFieldTrusted: boolean;
  smdh: SmdhTitles | null;
  iconRgba: Uint8ClampedArray | null;
  warnings: string[];
};

export class KgbError extends Error {
  warnings: string[];
  partial: Partial<Dossier> | null;

  constructor(message: string, warnings: string[] = [], partial: Partial<Dossier> | null = null) {
    super(message);
    this.name = "KgbError";
    this.warnings = warnings;
    this.partial = partial;
  }
}

export type CarrierLabel = {
  title: string;
  gameCode: string;
  maker: string;
  version: number;
  bytes: number;
  checksumOk: boolean;
  iconRgba?: Uint8ClampedArray | null;
};
