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

export type Dossier = {
  fileName: string;
  fileSize: number;
  titleId: string;
  productCode: string;
  encrypted: boolean;
  codeCompressed: boolean;
  decompressed: boolean;
  exefsNames: string[];
  offsets: Offsets;
  preambleBytes: number;
  gba: GbaHeader;
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
