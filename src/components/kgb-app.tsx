import { useEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, Terminal } from "lucide-react";
import { useSha256 } from "@/hooks/use-sha256";
import { assetUrl, downloadBlob, extensionOf, rgbaToPng } from "@/lib/download";
import { readImageFile } from "@/lib/image-file";
import {
  caaJson,
  formatBytes,
  romDownloadName,
  ndsDownloadName,
  trimTrailingFf,
} from "@/lib/kgb/format";
import { readGbaHeader } from "@/lib/kgb/gba";
import { matchGbLogo } from "@/lib/kgb/gb";
import { buildGoombaGba, loadGoombaBase } from "@/lib/kgb/goomba";
import {
  installBannerIcon,
  isNdsRom,
  looksLikeGba,
  packGbaAsNds,
  parseNds,
  previewHeaderIcon,
  squareImage,
  type NdsInfo,
  type RgbaImage,
} from "@/lib/kgb/nds";
import { parseCia, parseGbFile } from "@/lib/kgb/parse";
import { renderCarrierScreens, type CarrierLabel } from "@/lib/kgb/screen";
import { KgbError, type Dossier } from "@/lib/kgb/types";
import {
  cancelKgbWork,
  packNdsAsync,
  parseCiaAsync,
  parseNdsAsync,
  workerSupported,
} from "@/lib/kgb/work-client";
import { TabButton } from "./kgb/primitives";
import {
  CarrierPanel,
  CiaView,
  CliPanel,
  GbaView,
  NdsView,
  QueueBar,
} from "./kgb/panels";
import { EmulatorPlayer } from "./kgb/emulator-player";

type Tab = "dossier" | "cli" | "player";
type Entry =
  | { id: number; kind: "cia"; name: string; dossier: Dossier }
  | { id: number; kind: "gba"; name: string; rom: Uint8Array }
  | { id: number; kind: "nds"; name: string; info: NdsInfo; rom: Uint8Array };

type ErrShape = { message: string; warnings: string[]; partial: Partial<Dossier> | null };

const MAX_QUEUE = 20;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

let entrySeq = 0;

function toErrShape(err: unknown): ErrShape {
  if (err instanceof KgbError) return { message: err.message, warnings: err.warnings, partial: err.partial };
  const e = err as { message?: string; warnings?: string[]; partial?: Partial<Dossier> | null; name?: string };
  if (e && e.name === "KgbError") {
    return {
      message: e.message ?? "Could not read that file.",
      warnings: Array.isArray(e.warnings) ? e.warnings : [],
      partial: (e.partial as Partial<Dossier> | null) ?? null,
    };
  }
  return {
    message: err instanceof Error ? err.message : "Could not read that file.",
    warnings: [],
    partial: null,
  };
}

async function parseCiaSmart(buffer: ArrayBuffer, name: string): Promise<Dossier> {
  if (workerSupported()) {
    try {
      const { dossier } = await parseCiaAsync(buffer, name);
      return dossier;
    } catch (err) {
      if ((err as Error).message === "Worker unavailable." && buffer.byteLength > 0) {
        return parseCia(buffer, name);
      }
      throw err;
    }
  }
  return parseCia(buffer, name);
}

async function parseNdsSmart(
  buffer: ArrayBuffer,
  name: string,
): Promise<{ info: NdsInfo; rom: Uint8Array }> {
  if (workerSupported()) {
    try {
      return await parseNdsAsync(buffer, name);
    } catch (err) {
      if ((err as Error).message === "Worker unavailable." && buffer.byteLength > 0) {
        const bytes = new Uint8Array(buffer);
        return { info: parseNds(bytes, name), rom: bytes };
      }
      throw err;
    }
  }
  const bytes = new Uint8Array(buffer);
  return { info: parseNds(bytes, name), rom: bytes };
}

async function packNdsSmart(
  rom: Uint8Array,
  input: Omit<Parameters<typeof packGbaAsNds>[0], "rom">,
): Promise<Uint8Array> {
  if (workerSupported()) {
    try {
      const { nds } = await packNdsAsync(rom, input);
      return nds;
    } catch (err) {
      if ((err as Error).message === "Worker unavailable." || (err as Error).message === "Worker crashed.") {
        return packGbaAsNds({ ...input, rom });
      }
      throw err;
    }
  }
  return packGbaAsNds({ ...input, rom });
}

export function KgbApp() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorNotes, setErrorNotes] = useState<string[]>([]);
  const [errorPartial, setErrorPartial] = useState<Partial<Dossier> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trim, setTrim] = useState(false);
  const [tab, setTab] = useState<Tab>("dossier");
  const [script, setScript] = useState("");
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [headerIcon, setHeaderIcon] = useState(true);
  const [pickedIcon, setPickedIcon] = useState<{ name: string; image: RgbaImage } | null>(null);
  const [iconNote, setIconNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const active = entries.find((e) => e.id === activeId) ?? null;
  const dossier = active?.kind === "cia" ? active.dossier : null;
  const trimmed = useMemo(() => {
    if (!dossier) return null;
    const minSize = dossier.gb?.romSizeBytes ?? 0;
    return trimTrailingFf(dossier.rom, minSize);
  }, [dossier]);
  const ciaRom = trim && trimmed ? trimmed.bytes : dossier?.rom;
  const trimmedCount = trimmed?.trimmed ?? 0;

  const carryRom = useMemo(() => {
    if (active?.kind === "cia") return ciaRom ?? null;
    if (active?.kind === "gba") return active.rom;
    if (active?.kind === "nds") return active.info.gba?.rom ?? null;
    return null;
  }, [active, ciaRom]);

  const carryLabel = useMemo<CarrierLabel | null>(() => {
    if (!carryRom) return null;
    if (active?.kind === "cia" && dossier) {
      return {
        title: dossier.smdh?.short || dossier.gb?.title || dossier.gba.title,
        gameCode: dossier.gba.gameCode,
        maker: dossier.gba.maker,
        version: dossier.gba.version,
        bytes: carryRom.length,
        checksumOk: dossier.gb ? dossier.gb.checksumOk : dossier.gba.checksumOk,
        iconRgba: dossier.iconRgba,
      };
    }
    if (active?.kind === "gba") {
      const header = readGbaHeader(active.rom);
      return {
        title: header.title,
        gameCode: header.gameCode,
        maker: header.maker,
        version: header.version,
        bytes: carryRom.length,
        checksumOk: header.checksumOk,
        iconRgba: null,
      };
    }
    if (active?.kind === "nds" && active.info.gba) {
      const header = active.info.gba.header;
      return {
        title: header.title,
        gameCode: header.gameCode,
        maker: header.maker,
        version: header.version,
        bytes: carryRom.length,
        checksumOk: header.checksumOk,
        iconRgba: active.info.iconRgba,
      };
    }
    return null;
  }, [carryRom, dossier, active]);

  const playable = useMemo(() => {
    if (!active) return null;
    if (active.kind === "cia") {
      return {
        rom: active.dossier.rom,
        title: active.dossier.smdh?.short || active.dossier.gb?.title || active.dossier.gba.title || "Game",
        system: (active.dossier.system || "gba") as "gba" | "gb" | "gbc",
      };
    }
    if (active.kind === "gba") {
      const header = readGbaHeader(active.rom);
      return {
        rom: active.rom,
        title: header.title || active.name.replace(/\.[^.]+$/, ""),
        system: "gba" as const,
      };
    }
    if (active.kind === "nds" && active.info.gba) {
      return {
        rom: active.info.gba.rom,
        title: active.info.gba.header.title || active.name.replace(/\.[^.]+$/, ""),
        system: "gba" as const,
      };
    }
    return null;
  }, [active]);

  const screens = useMemo(() => (carryLabel ? renderCarrierScreens(carryLabel) : null), [carryLabel]);

  const bannerSource = useMemo(() => {
    if (!headerIcon) return null;
    return pickedIcon?.image ?? squareImage(carryLabel?.iconRgba) ?? null;
  }, [carryLabel, headerIcon, pickedIcon]);
  const headerPreview = useMemo(
    () => (carryLabel ? previewHeaderIcon(carryLabel.gameCode, bannerSource) : null),
    [bannerSource, carryLabel],
  );

  const sha = useSha256(carryRom);

  useEffect(() => {
    return () => {
      cancelKgbWork();
    };
  }, []);

  function loadScript() {
    setScriptError(null);
    fetch(assetUrl("kgb.py"))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setScript(text);
        setScriptError(null);
      })
      .catch(() => setScriptError("The script could not be loaded."));
  }

  useEffect(() => {
    if (tab !== "cli" || script || scriptError) return;
    loadScript();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function fail(err: unknown) {
    const shaped = toErrShape(err);
    if (shaped.message === "Cancelled.") return;
    setError(shaped.message);
    setErrorNotes(shaped.warnings);
    setErrorPartial(shaped.partial);
  }

  async function ingestOne(file: File): Promise<Entry> {
    if (file.size > MAX_FILE_BYTES) {
      throw new KgbError(
        `"${file.name}" is ${formatBytes(file.size)} — please use a file under 256 MiB.`,
      );
    }
    const buf = await file.arrayBuffer();
    // Magic wins over the extension: renamed files still route correctly.
    const peek = new Uint8Array(buf);
    if (isNdsRom(peek)) {
      const { info, rom } = await parseNdsSmart(buf, file.name);
      return { id: ++entrySeq, kind: "nds", name: file.name, info, rom };
    }
    if (looksLikeGba(peek)) {
      if (peek.length < 0xc0) throw new KgbError("That file is too small to be a GBA game.");
      return { id: ++entrySeq, kind: "gba", name: file.name, rom: new Uint8Array(buf) };
    }
    const ext = extensionOf(file.name);
    if (ext === "nds" || ext === "srl") {
      throw new KgbError("Not an NDS cartridge. The Nintendo logo at 0xC0 never matched.");
    }
    if (ext === "gba" || ext === "agb") {
      if (peek.length < 0xc0) throw new KgbError("That file is too small to be a GBA game.");
      return { id: ++entrySeq, kind: "gba", name: file.name, rom: new Uint8Array(buf) };
    }
    if (ext === "gb" || ext === "gbc" || matchGbLogo(peek, 0x104)) {
      if (peek.length < 0x150) throw new KgbError("That file is too small to be a Game Boy ROM.");
      const dossier = parseGbFile(buf, file.name);
      return { id: ++entrySeq, kind: "cia", name: file.name, dossier };
    }
    const dossier = await parseCiaSmart(buf, file.name);
    return { id: ++entrySeq, kind: "cia", name: file.name, dossier };
  }

  async function onFiles(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    const room = MAX_QUEUE - entries.length;
    if (room <= 0) {
      setError(`The queue holds ${MAX_QUEUE} files. Remove one first.`);
      setErrorNotes([]);
      setErrorPartial(null);
      return;
    }
    const batch = files.slice(0, room);
    setError(null);
    setErrorNotes([]);
    setErrorPartial(null);
    setPickedIcon(null);
    setIconNote(null);
    setBusy(`Reading ${batch.length > 1 ? `${batch.length} files` : batch[0]?.name ?? "file"}…`);
    busyRef.current = true;
    try {
      const made: Entry[] = [];
      const errors: string[] = [];
      for (const file of batch) {
        try {
          // Sequential: keeps peak memory to one file at a time.
          made.push(await ingestOne(file));
        } catch (err) {
          const shaped = toErrShape(err);
          if (shaped.message === "Cancelled.") break;
          errors.push(`"${file.name}": ${shaped.message}`);
        }
        if (!busyRef.current) break;
      }
      if (made.length > 0) {
        setEntries((prev) => [...prev, ...made].slice(-MAX_QUEUE));
        setActiveId(made[made.length - 1]!.id);
        setTab("dossier");
      }
      const notes: string[] = [];
      if (files.length > batch.length) {
        notes.push(`Only ${batch.length} files were queued (max ${MAX_QUEUE}).`);
      }
      if (errors.length > 0) {
        setError(errors.length === 1 ? errors[0]! : `${errors.length} files could not be read.`);
        setErrorNotes([...notes, ...(errors.length > 1 ? errors : [])]);
      } else if (notes.length > 0) {
        setError("Queue limit reached.");
        setErrorNotes(notes);
      }
    } catch (err) {
      fail(err);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function cancelBusy() {
    busyRef.current = false;
    cancelKgbWork();
    setBusy(null);
  }

  async function saveRomExt(ext: "gb" | "gbc" | "gba") {
    if (!dossier || !ciaRom) return;
    const title = dossier.gb?.title || dossier.gba.title;
    const code = dossier.gba.gameCode;
    if (ext === "gba" && (dossier.system === "gb" || dossier.system === "gbc")) {
      setBusy("Packing .gba (Goomba runner)…");
      busyRef.current = true;
      try {
        const goombaBase = await loadGoombaBase();
        const gbaBytes = buildGoombaGba(goombaBase, ciaRom, title);
        downloadBlob(new Blob([new Uint8Array(gbaBytes)]), romDownloadName(title, code, "gba"));
      } catch (err: unknown) {
        fail(err);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
      return;
    }
    downloadBlob(new Blob([new Uint8Array(ciaRom)]), romDownloadName(title, code, ext));
  }

  function saveJson() {
    if (!dossier || !ciaRom) return;
    const title = dossier.gb?.title || dossier.gba.title;
    const code = dossier.gba.gameCode;
    const body = caaJson(dossier, trim && trimmedCount > 0, ciaRom.length);
    const stem = romDownloadName(title, code, "rom").replace(/\.rom$/, "");
    downloadBlob(new Blob([body], { type: "application/json" }), `${stem}.caa.json`);
  }

  function saveFooter() {
    if (!dossier) return;
    const title = dossier.gb?.title || dossier.gba.title;
    const code = dossier.gba.gameCode;
    const stem = romDownloadName(title, code, "rom").replace(/\.rom$/, "");
    downloadBlob(new Blob([new Uint8Array(dossier.caa.footer)]), `${stem}.caa.bin`);
  }

  async function saveIcon() {
    if (!dossier?.iconRgba) return;
    const title = dossier.gb?.title || dossier.gba.title;
    const code = dossier.gba.gameCode;
    const stem = romDownloadName(title, code, "rom").replace(/\.rom$/, "");
    downloadBlob(await rgbaToPng(dossier.iconRgba, 48), `${stem}.png`);
  }

  async function saveNds() {
    if (!carryRom || !carryLabel) return;
    setBusy("Packing .nds…");
    busyRef.current = true;
    try {
      const romFileName =
        dossier?.system === "gb"
          ? "rom.gb"
          : dossier?.system === "gbc"
            ? "rom.gbc"
            : "rom.gba";
      const nds = await packNdsSmart(carryRom, {
        title: carryLabel.title,
        gameCode: carryLabel.gameCode,
        maker: carryLabel.maker,
        version: carryLabel.version,
        checksumOk: carryLabel.checksumOk,
        iconRgba: carryLabel.iconRgba,
        bannerImage: bannerSource,
        romFileName,
      });
      downloadBlob(new Blob([new Uint8Array(nds)]), ndsDownloadName(carryLabel.title, carryLabel.gameCode));
      try {
        const info = parseNds(nds, ndsDownloadName(carryLabel.title, carryLabel.gameCode));
        const entry: Entry = { id: ++entrySeq, kind: "nds", name: info.fileName, info, rom: nds };
        setEntries((prev) => [...prev, entry].slice(-MAX_QUEUE));
        setActiveId(entry.id);
      } catch {
        /* download already succeeded; queueing is best-effort */
      }
    } catch (err) {
      fail(err);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function saveEmbeddedGba() {
    if (active?.kind !== "nds" || !active.info.gba) return;
    const header = active.info.gba.header;
    downloadBlob(new Blob([new Uint8Array(active.info.gba.rom)]), romDownloadName(header.title, header.gameCode));
  }

  async function saveBannerIcon() {
    if (active?.kind !== "nds" || !active.info.iconRgba) return;
    const stem = ndsDownloadName(active.info.title, active.info.gameCode).replace(/\.nds$/, "");
    downloadBlob(await rgbaToPng(active.info.iconRgba, 32), `${stem}.png`);
  }

  function onPickIcon(file: File) {
    readImageFile(file)
      .then((image) => {
        setPickedIcon({ name: file.name, image });
        setIconNote(null);
        setHeaderIcon(true);
      })
      .catch((err: unknown) => {
        setIconNote(err instanceof Error ? err.message : "That picture could not be read.");
      });
  }

  function savePatchedNds() {
    if (active?.kind !== "nds" || !pickedIcon) return;
    try {
      const patched = installBannerIcon(active.rom, pickedIcon.image);
      const base = active.info.fileName.replace(/\.(nds|srl)$/i, "") || "cartridge";
      const name = `${base}.icon.nds`;
      downloadBlob(new Blob([new Uint8Array(patched)]), name);
      const info = parseNds(patched, name);
      const entry: Entry = { id: ++entrySeq, kind: "nds", name, info, rom: patched };
      setEntries((prev) => [...prev, entry].slice(-MAX_QUEUE));
      setActiveId(entry.id);
      setPickedIcon(null);
      setIconNote(null);
    } catch (err) {
      setIconNote(err instanceof Error ? err.message : "The header could not take that icon.");
    }
  }

  function downloadNdsFile(index: number) {
    if (active?.kind !== "nds") return;
    const file = active.info.files[index];
    if (!file) return;
    const bytes = active.rom.subarray(file.start, file.start + file.size);
    downloadBlob(new Blob([new Uint8Array(bytes)]), file.name.split("/").pop() || "extracted");
  }

  function downloadAllNdsFiles() {
    if (active?.kind !== "nds") return;
    active.info.files.forEach((file, i) => {
      if (file.size > 8 * 1024 * 1024) return;
      window.setTimeout(() => downloadNdsFile(i), i * 400);
    });
  }

  function copyScript() {
    if (!script) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = script;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
      } catch {
        setScriptError("Copy failed — select the text manually.");
      }
    };
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(script).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
        <p className="text-sm font-extrabold text-line-deep">GBA and DS files</p>
        <h1 className="text-4xl font-extrabold leading-none text-ink">KGB</h1>
        <p className="mt-2 max-w-lg text-base font-semibold leading-snug text-ink">
          Get the GBA or GB/GBC game out of a 3DS file. Pack it into a DS file. Change the DS menu icon.
        </p>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6" aria-busy={busy !== null}>
        <section
          className={"window px-4 py-5 sm:px-5 " + (dragOver ? "ring-4 ring-gold" : "")}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void onFiles(event.dataTransfer.files);
          }}
          tabIndex={0}
          role="button"
          aria-label="Drop files here, or press Enter to choose files"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) inputRef.current?.click();
          }}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-extrabold">Drop .cia, .gba, .gb, or .nds</h2>
              <p className="mt-1 text-sm font-semibold text-muted">
                Stays in this browser. Nothing is uploaded.
                {busy ? ` ${busy}` : " Multiple files queue up (max 20)."}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => inputRef.current?.click()}
              >
                Choose files
              </button>
              {busy && (
                <button type="button" className="btn btn-ghost" onClick={cancelBusy}>
                  Cancel
                </button>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".cia,.cxi,.app,.gba,.agb,.gb,.gbc,.nds,.srl,application/octet-stream"
              multiple
              className="sr-only"
              suppressHydrationWarning
              onChange={(event) => {
                void onFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        </section>

        <QueueBar
          entries={entries.map((e) => ({ id: e.id, name: e.name, kind: e.kind }))}
          activeId={activeId}
          onSelect={setActiveId}
          onRemove={(id) => {
            setEntries((prev) => prev.filter((e) => e.id !== id));
            if (id === activeId) setActiveId(null);
          }}
          onClear={() => {
            cancelKgbWork();
            busyRef.current = false;
            setBusy(null);
            setEntries([]);
            setActiveId(null);
            setError(null);
          }}
        />

        <div className="flex items-center gap-2">
          <TabButton active={tab === "dossier"} onClick={() => setTab("dossier")}>
            File
          </TabButton>
          <TabButton active={tab === "player"} onClick={() => setTab("player")}>
            <Gamepad2 className="size-4" />
            Play & Test
          </TabButton>
          <TabButton active={tab === "cli"} onClick={() => setTab("cli")}>
            <Terminal className="size-4" />
            Script
          </TabButton>
          {active && (
            <button
              type="button"
              className="ml-auto min-h-11 px-2 text-sm font-extrabold text-line-deep underline-offset-2 hover:underline"
              onClick={() => {
                setEntries((prev) => prev.filter((e) => e.id !== active.id));
                setActiveId(null);
                setError(null);
                setErrorPartial(null);
                setTab("dossier");
              }}
            >
              Close
            </button>
          )}
        </div>

        {tab === "player" ? (
          playable ? (
            <EmulatorPlayer
              rom={playable.rom}
              title={playable.title}
              system={playable.system}
              onClose={() => setTab("dossier")}
            />
          ) : (
            <section className="window flex flex-col items-center justify-center p-8 text-center">
              <Gamepad2 className="size-12 text-muted" />
              <h3 className="mt-3 font-extrabold text-line">No ROM selected</h3>
              <p className="mt-1 max-w-md text-sm font-semibold text-muted">
                Drop or open a 3DS Virtual Console CIA (.cia), Game Boy ROM (.gb), Game Boy Color (.gbc), or Game Boy Advance (.gba) to play and test it here.
              </p>
            </section>
          )
        ) : tab === "cli" ? (
          <CliPanel
            script={script}
            scriptError={scriptError}
            onRetry={loadScript}
            copied={copied}
            onCopy={copyScript}
          />
        ) : (
          <>
            {error && (
              <section className="window p-4" role="alert" aria-live="assertive">
                <div className="flex items-start gap-3">
                  <div>
                    <h2 className="font-extrabold text-red">Couldn’t read that file</h2>
                    <p className="mt-1 text-sm font-semibold leading-relaxed">{error}</p>
                    {errorNotes.length > 0 && (
                      <ul className="mt-2 list-disc pl-4 text-sm font-semibold text-muted">
                        {errorNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                    {errorPartial?.titleId && (
                      <p className="mt-2 text-xs font-semibold text-muted">
                        What we could read: title {errorPartial.titleId} · product{" "}
                        {errorPartial.productCode || "—"} · files{" "}
                        {(errorPartial.exefsNames ?? []).filter(Boolean).join(" ") || "—"}.
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}

            {!active && !error && (
              <section className="grid gap-3 sm:grid-cols-3">
                {[
                  ["CIA to GBA", "Open a 3DS Virtual Console .cia and download the GBA ROM."],
                  ["GBA to DS", "Pack a .gba into a .nds. The DS shows a title card and keeps the ROM inside."],
                  ["DS file", "Download a stored GBA ROM, or replace the menu icon."],
                ].map(([title, body]) => (
                  <article key={title} className="window p-4">
                    <h3 className="font-extrabold text-line">{title}</h3>
                    <p className="mt-2 text-sm font-semibold leading-relaxed text-muted">{body}</p>
                  </article>
                ))}
              </section>
            )}

            {dossier && ciaRom && (
              <CiaView
                dossier={dossier}
                trim={trim}
                setTrim={setTrim}
                trimmedCount={trimmedCount}
                outSize={ciaRom.length}
                sha={sha}
                onRom={() => void saveRomExt(dossier.system === "gb" ? "gb" : dossier.system === "gbc" ? "gbc" : "gba")}
                onDownloadGb={() => void saveRomExt("gb")}
                onDownloadGbc={() => void saveRomExt("gbc")}
                onDownloadGba={() => void saveRomExt("gba")}
                onPlay={() => setTab("player")}
                onJson={saveJson}
                onFooter={saveFooter}
                onIcon={saveIcon}
              />
            )}

            {active?.kind === "gba" && (
              <GbaView fileName={active.name} rom={active.rom} sha={sha} onPlay={() => setTab("player")} />
            )}

            {active?.kind === "nds" && (
              <NdsView
                info={active.info}
                sha={sha}
                busy={busy !== null}
                onGba={saveEmbeddedGba}
                onIcon={saveBannerIcon}
                onDownloadFile={downloadNdsFile}
                onDownloadAll={downloadAllNdsFiles}
                pickedName={pickedIcon?.name ?? null}
                pickedPreview={pickedIcon ? previewHeaderIcon(active.info.gameCode, pickedIcon.image) : null}
                iconNote={iconNote}
                onPick={onPickIcon}
                onClearPick={() => setPickedIcon(null)}
                onPatch={savePatchedNds}
              />
            )}

            {screens && carryLabel && headerPreview && (
              <CarrierPanel
                label={carryLabel}
                top={screens.top}
                bottom={screens.bottom}
                busy={busy !== null}
                onPack={() => void saveNds()}
                headerIcon={headerIcon}
                setHeaderIcon={setHeaderIcon}
                usingPicture={bannerSource !== null}
                preview={headerPreview}
                pickedName={pickedIcon?.name ?? null}
                iconNote={active?.kind === "nds" ? null : iconNote}
                showFile={active?.kind !== "nds"}
                onPick={onPickIcon}
                onClearPick={() => {
                  setPickedIcon(null);
                  setIconNote(null);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
