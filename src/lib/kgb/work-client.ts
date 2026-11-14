import type { CarrierInput, NdsInfo } from "./nds.ts";
import type { Dossier } from "./types.ts";

type Pending = {
  resolve: (value: never) => void;
  reject: (err: Error & { warnings?: string[]; partial?: unknown }) => void;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./kgb-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { id: number; ok: boolean; [k: string]: unknown };
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg as never);
    else {
      const err = new Error((msg.message as string) || "Worker failed.") as Error & {
        warnings?: string[];
        partial?: unknown;
      };
      err.warnings = (msg.warnings as string[]) ?? [];
      err.partial = (msg.partial as unknown) ?? null;
      (err as { name?: string }).name = "KgbError";
      entry.reject(err);
    }
  };
  worker.onerror = () => {
    for (const [, entry] of pending) {
      entry.reject(Object.assign(new Error("Worker crashed."), { warnings: [] }));
    }
    pending.clear();
    worker = null;
  };
  return worker;
}

function callWorker<T>(send: (w: Worker, id: number) => void): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(Object.assign(new Error("Worker unavailable."), { code: "NO_WORKER" }));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    try {
      send(w, id);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/** Terminate the worker and reject everything in flight. Recreated on next call. */
export function cancelKgbWork(reason = "Cancelled."): void {
  try {
    worker?.terminate();
  } catch {
    /* noop */
  }
  worker = null;
  for (const [, entry] of pending) {
    entry.reject(Object.assign(new Error(reason), { warnings: [] }));
  }
  pending.clear();
}

export function workerSupported(): boolean {
  return typeof Worker !== "undefined";
}

export function parseCiaAsync(buffer: ArrayBuffer, fileName: string): Promise<{ dossier: Dossier }> {
  return callWorker<{ dossier: Dossier }>((w, id) => {
    w.postMessage({ id, kind: "parse-cia", buffer, fileName }, [buffer]);
  });
}

export function parseNdsAsync(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<{ info: NdsInfo; rom: Uint8Array }> {
  return callWorker<{ info: NdsInfo; rom: Uint8Array }>((w, id) => {
    w.postMessage({ id, kind: "parse-nds", buffer, fileName }, [buffer]);
  });
}

export function packNdsAsync(
  rom: Uint8Array,
  input: Omit<CarrierInput, "rom">,
): Promise<{ nds: Uint8Array }> {
  const copy = new Uint8Array(rom);
  return callWorker<{ nds: Uint8Array }>((w, id) => {
    w.postMessage({ id, kind: "pack-nds", rom: copy.buffer, input }, [copy.buffer]);
  });
}
