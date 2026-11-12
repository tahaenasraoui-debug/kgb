/** 3DS backward LZ (BLZ) used on compressed ExeFS `.code`. */

const MAX_OUT = 64 * 1024 * 1024;

export function blzDecompress(input: Uint8Array<ArrayBufferLike>): Uint8Array {
  if (input.length < 8) throw new Error("BLZ payload is shorter than the 8-byte footer.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const header = view.getUint32(input.length - 8, true);
  const extra = view.getUint32(input.length - 4, true);
  const compressedSize = header & 0x00ffffff;
  const footerSize = header >>> 24;
  if (footerSize < 8 || compressedSize < footerSize || compressedSize > input.length) {
    throw new Error("BLZ footer is not plausible (compressed length / footer size).");
  }
  if (extra > MAX_OUT) throw new Error("BLZ extra size is unreasonably large.");
  const outSize = input.length + extra;
  if (outSize > MAX_OUT) throw new Error("BLZ output would exceed 64 MiB.");

  const out = new Uint8Array(outSize);
  out.set(input);

  let src = input.length - footerSize;
  let dst = outSize;
  const end = input.length - compressedSize;

  while (src > end) {
    src -= 1;
    let flags = out[src]!;
    for (let i = 0; i < 8; i++) {
      if (src <= end) break;
      if (flags & 0x80) {
        if (src < end + 2) throw new Error("BLZ stream truncated inside a back-reference.");
        src -= 1;
        const b1 = out[src]!;
        src -= 1;
        const b2 = out[src]!;
        const length = (b1 >> 4) + 3;
        const disp = (((b1 & 0x0f) << 8) | b2) + 3;
        for (let j = 0; j < length; j++) {
          dst -= 1;
          if (dst < 0 || dst + disp >= out.length) throw new Error("BLZ back-reference walked out of range.");
          out[dst] = out[dst + disp]!;
        }
      } else {
        src -= 1;
        dst -= 1;
        if (dst < 0 || src < 0) throw new Error("BLZ literal walked out of range.");
        out[dst] = out[src]!;
      }
      flags = (flags << 1) & 0xff;
    }
  }
  return out;
}
