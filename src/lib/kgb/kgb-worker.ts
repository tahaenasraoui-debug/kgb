import { parseNds, packGbaAsNds, type CarrierInput } from "./nds.ts";
import { parseCia } from "./parse.ts";

type InMsg =
  | { id: number; kind: "parse-cia"; buffer: ArrayBuffer; fileName: string }
  | { id: number; kind: "parse-nds"; buffer: ArrayBuffer; fileName: string }
  | { id: number; kind: "pack-nds"; rom: ArrayBuffer; input: Omit<CarrierInput, "rom"> };

function isSafeToTransfer(buf: unknown, forbidden: ArrayBuffer): buf is ArrayBuffer {
  if (!(buf instanceof ArrayBuffer)) return false;
  if (buf === forbidden) return false;
  if (buf.byteLength === 0) return false;
  if ((buf as { detached?: boolean }).detached === true) return false;
  return true;
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  try {
    if (msg.kind === "parse-cia") {
      const dossier = parseCia(msg.buffer, msg.fileName);
      const transfer: ArrayBuffer[] = [];
      if (isSafeToTransfer(dossier.rom.buffer, msg.buffer)) transfer.push(dossier.rom.buffer);
      if (dossier.iconRgba && isSafeToTransfer(dossier.iconRgba.buffer, msg.buffer)) {
        transfer.push(dossier.iconRgba.buffer);
      }
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, dossier }, transfer);
    } else if (msg.kind === "parse-nds") {
      const info = parseNds(msg.buffer, msg.fileName);
      const transfer: ArrayBuffer[] = [];
      if (info.iconRgba && isSafeToTransfer(info.iconRgba.buffer, msg.buffer)) transfer.push(info.iconRgba.buffer);
      if (info.gba && isSafeToTransfer(info.gba.rom.buffer, msg.buffer)) transfer.push(info.gba.rom.buffer);
      const rom = new Uint8Array(msg.buffer);
      if (isSafeToTransfer(rom.buffer, msg.buffer) && !transfer.includes(rom.buffer)) transfer.push(rom.buffer);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, info, rom }, transfer);
    } else {
      const rom = new Uint8Array(msg.rom);
      const nds = packGbaAsNds({ ...msg.input, rom });
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, nds }, [nds.buffer as ArrayBuffer]);
    }
  } catch (err) {
    const error = err as { message?: string; warnings?: string[]; partial?: unknown };
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      message: error?.message ?? "Worker failed.",
      warnings: Array.isArray(error?.warnings) ? error.warnings : [],
      partial: error?.partial ?? null,
    });
  }
};
