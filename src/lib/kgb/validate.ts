import { formatBytes } from "./format.ts";

const MIN_LICENSED_GBA = 4 * 1024 * 1024;
const MAX_LICENSED_GBA = 32 * 1024 * 1024;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export type GbaSizeVerdict = { label: string; detail: string; ok: boolean };

/** Licensed GBA cartridges are powers of two between 4 MiB and 32 MiB. Anything else is a hint, not a failure. */
export function describeGbaSize(bytes: number): GbaSizeVerdict {
  if (bytes > MAX_LICENSED_GBA) {
    return {
      label: formatBytes(bytes),
      detail: "Larger than any licensed GBA cartridge (32 MiB) — likely an overdump",
      ok: false,
    };
  }
  if (bytes >= MIN_LICENSED_GBA && isPowerOfTwo(bytes)) {
    return { label: formatBytes(bytes), detail: "Licensed cartridge size", ok: true };
  }
  return {
    label: formatBytes(bytes),
    detail: "Not a power of two — trimmed or homebrew size, still packable",
    ok: true,
  };
}
