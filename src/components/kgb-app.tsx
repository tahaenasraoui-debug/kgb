import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, FileCode2, Terminal, TriangleAlert } from "lucide-react";
import {
  caaJson,
  dossierLog,
  formatBytes,
  ghostingLabel,
  hex,
  ndsDownloadName,
  romDownloadName,
  trimTrailingFf,
} from "@/lib/kgb/format";
import { readGbaHeader } from "@/lib/kgb/gba";
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
import { parseCia } from "@/lib/kgb/parse";
import { expand555, renderCarrierScreens, type CarrierLabel } from "@/lib/kgb/screen";
import { KgbError, type Dossier } from "@/lib/kgb/types";

type Tab = "dossier" | "cli";
type Loaded =
  | { kind: "cia"; dossier: Dossier }
  | { kind: "gba"; fileName: string; rom: Uint8Array }
  | { kind: "nds"; info: NdsInfo; rom: Uint8Array };

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function rgbaToPng(rgba: Uint8ClampedArray, size: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas is unavailable."));
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed."))), "image/png");
  });
}

function readImageFile(file: File): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const limit = 256;
      const scale = Math.min(1, limit / Math.max(img.width, img.height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas is unavailable."));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ rgba: data.data, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That picture could not be read."));
    };
    img.src = url;
  });
}

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function KgbApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorNotes, setErrorNotes] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [trim, setTrim] = useState(false);
  const [tab, setTab] = useState<Tab>("dossier");
  const [sha, setSha] = useState("");
  const [script, setScript] = useState("");
  const [copied, setCopied] = useState(false);
  const [headerIcon, setHeaderIcon] = useState(true);
  const [pickedIcon, setPickedIcon] = useState<{ name: string; image: RgbaImage } | null>(null);
  const [iconNote, setIconNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const dossier = loaded?.kind === "cia" ? loaded.dossier : null;
  const trimmed = useMemo(() => (dossier ? trimTrailingFf(dossier.rom) : null), [dossier]);
  const ciaRom = trim && trimmed ? trimmed.bytes : dossier?.rom;
  const trimmedCount = trimmed?.trimmed ?? 0;

  const carryRom = useMemo(() => {
    if (loaded?.kind === "cia") return ciaRom ?? null;
    if (loaded?.kind === "gba") return loaded.rom;
    if (loaded?.kind === "nds") return loaded.info.gba?.rom ?? null;
    return null;
  }, [loaded, ciaRom]);

  const carryLabel = useMemo<CarrierLabel | null>(() => {
    if (!carryRom) return null;
    if (loaded?.kind === "cia" && dossier) {
      return {
        title: dossier.smdh?.short || dossier.gba.title,
        gameCode: dossier.gba.gameCode,
        maker: dossier.gba.maker,
        version: dossier.gba.version,
        bytes: carryRom.length,
        checksumOk: dossier.gba.checksumOk,
        iconRgba: dossier.iconRgba,
      };
    }
    if (loaded?.kind === "gba") {
      const header = readGbaHeader(loaded.rom);
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
    if (loaded?.kind === "nds" && loaded.info.gba) {
      const header = loaded.info.gba.header;
      return {
        title: header.title,
        gameCode: header.gameCode,
        maker: header.maker,
        version: header.version,
        bytes: carryRom.length,
        checksumOk: header.checksumOk,
        iconRgba: loaded.info.iconRgba,
      };
    }
    return null;
  }, [carryRom, dossier, loaded]);

  const screens = useMemo(() => (carryLabel ? renderCarrierScreens(carryLabel) : null), [carryLabel]);

  const bannerSource = useMemo(() => {
    if (!headerIcon) return null;
    return pickedIcon?.image ?? squareImage(carryLabel?.iconRgba) ?? null;
  }, [carryLabel, headerIcon, pickedIcon]);
  const headerPreview = useMemo(
    () => (carryLabel ? previewHeaderIcon(carryLabel.gameCode, bannerSource) : null),
    [bannerSource, carryLabel],
  );

  useEffect(() => {
    if (!carryRom) {
      setSha("");
      return;
    }
    let cancel = false;
    crypto.subtle.digest("SHA-256", new Uint8Array(carryRom)).then((buf) => {
      if (cancel) return;
      setSha(Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(""));
    });
    return () => {
      cancel = true;
    };
  }, [carryRom]);

  useEffect(() => {
    if (tab !== "cli" || script) return;
    fetch("/kgb.py")
      .then((r) => r.text())
      .then(setScript)
      .catch(() => setScript("The script could not be loaded."));
  }, [tab, script]);

  function fail(err: unknown) {
    setLoaded(null);
    if (err instanceof KgbError) {
      setError(err.message);
      setErrorNotes(err.warnings);
    } else {
      setError(err instanceof Error ? err.message : "Could not read that file.");
      setErrorNotes([]);
    }
  }

  function ingest(buffer: ArrayBuffer, name: string) {
    setError(null);
    setErrorNotes([]);
    setPickedIcon(null);
    setIconNote(null);
    const bytes = new Uint8Array(buffer);
    const ext = extensionOf(name);
    try {
      if (ext === "nds" || ext === "srl" || (ext !== "cia" && ext !== "cxi" && ext !== "gba" && ext !== "agb" && isNdsRom(bytes))) {
        setLoaded({ kind: "nds", info: parseNds(buffer, name), rom: bytes });
        setTab("dossier");
        return;
      }
      if (ext === "gba" || ext === "agb" || (ext !== "cia" && ext !== "cxi" && looksLikeGba(bytes))) {
        if (bytes.length < 0xc0) throw new KgbError("That file is too small to be a GBA game.");
        setLoaded({ kind: "gba", fileName: name, rom: bytes });
        setTab("dossier");
        return;
      }
      setLoaded({ kind: "cia", dossier: parseCia(buffer, name) });
      setTab("dossier");
    } catch (err) {
      fail(err);
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    file.arrayBuffer().then((buf) => ingest(buf, file.name));
  }

  function saveRom() {
    if (!dossier || !ciaRom) return;
    downloadBlob(new Blob([new Uint8Array(ciaRom)]), romDownloadName(dossier.gba.title, dossier.gba.gameCode));
  }

  function saveJson() {
    if (!dossier || !ciaRom) return;
    const body = caaJson(dossier, trim && trimmedCount > 0, ciaRom.length);
    const stem = romDownloadName(dossier.gba.title, dossier.gba.gameCode).replace(/\.gba$/, "");
    downloadBlob(new Blob([body], { type: "application/json" }), `${stem}.caa.json`);
  }

  function saveFooter() {
    if (!dossier) return;
    const stem = romDownloadName(dossier.gba.title, dossier.gba.gameCode).replace(/\.gba$/, "");
    downloadBlob(new Blob([new Uint8Array(dossier.caa.footer)]), `${stem}.caa.bin`);
  }

  async function saveIcon() {
    if (!dossier?.iconRgba) return;
    const stem = romDownloadName(dossier.gba.title, dossier.gba.gameCode).replace(/\.gba$/, "");
    downloadBlob(await rgbaToPng(dossier.iconRgba, 48), `${stem}.png`);
  }

  function saveNds() {
    if (!carryRom || !carryLabel) return;
    const nds = packGbaAsNds({
      rom: carryRom,
      title: carryLabel.title,
      gameCode: carryLabel.gameCode,
      maker: carryLabel.maker,
      version: carryLabel.version,
      checksumOk: carryLabel.checksumOk,
      iconRgba: carryLabel.iconRgba,
      bannerImage: bannerSource,
    });
    downloadBlob(new Blob([new Uint8Array(nds)]), ndsDownloadName(carryLabel.title, carryLabel.gameCode));
  }

  function saveEmbeddedGba() {
    if (loaded?.kind !== "nds" || !loaded.info.gba) return;
    const header = loaded.info.gba.header;
    downloadBlob(new Blob([new Uint8Array(loaded.info.gba.rom)]), romDownloadName(header.title, header.gameCode));
  }

  async function saveBannerIcon() {
    if (loaded?.kind !== "nds" || !loaded.info.iconRgba) return;
    const stem = ndsDownloadName(loaded.info.title, loaded.info.gameCode).replace(/\.nds$/, "");
    downloadBlob(await rgbaToPng(loaded.info.iconRgba, 32), `${stem}.png`);
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
    if (loaded?.kind !== "nds" || !pickedIcon) return;
    try {
      const patched = installBannerIcon(loaded.rom, pickedIcon.image);
      const base = loaded.info.fileName.replace(/\.(nds|srl)$/i, "") || "cartridge";
      const name = `${base}.icon.nds`;
      downloadBlob(new Blob([new Uint8Array(patched)]), name);
      setLoaded({ kind: "nds", info: parseNds(patched, name), rom: patched });
      setPickedIcon(null);
      setIconNote(null);
    } catch (err) {
      setIconNote(err instanceof Error ? err.message : "The header could not take that icon.");
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
        <p className="text-sm font-extrabold text-line-deep">GBA and DS files</p>
        <h1 className="text-4xl font-extrabold leading-none text-ink">KGB</h1>
        <p className="mt-2 max-w-lg text-base font-semibold leading-snug text-ink">
          Get the GBA game out of a 3DS file. Pack it into a DS file. Change the DS menu icon.
        </p>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6">
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
            onFile(event.dataTransfer.files[0]);
          }}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-extrabold">Drop a .cia, .gba, or .nds</h2>
              <p className="mt-1 text-sm font-semibold text-muted">Stays in this browser. Nothing is uploaded.</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".cia,.cxi,.app,.gba,.agb,.nds,.srl,application/octet-stream"
              className="sr-only"
              suppressHydrationWarning
              onChange={(event) => onFile(event.target.files?.[0])}
            />
          </div>
        </section>

        <div className="flex items-center gap-2">
          <TabButton active={tab === "dossier"} onClick={() => setTab("dossier")}>
            File
          </TabButton>
          <TabButton active={tab === "cli"} onClick={() => setTab("cli")}>
            <Terminal className="size-4" />
            Script
          </TabButton>
          {loaded && (
            <button
              type="button"
              className="ml-auto min-h-11 px-2 text-sm font-extrabold text-line-deep underline-offset-2 hover:underline"
              onClick={() => {
                setLoaded(null);
                setError(null);
                setTab("dossier");
              }}
            >
              Close
            </button>
          )}
        </div>

        {tab === "cli" ? (
          <CliPanel
            script={script}
            copied={copied}
            onCopy={() => {
              navigator.clipboard.writeText(script).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          />
        ) : (
          <>
            {error && (
              <section className="window p-4" role="alert">
                <div className="flex items-start gap-3">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0 text-red" aria-hidden="true" />
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
                  </div>
                </div>
              </section>
            )}

            {!loaded && !error && (
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
                onRom={saveRom}
                onJson={saveJson}
                onFooter={saveFooter}
                onIcon={saveIcon}
              />
            )}

            {loaded?.kind === "gba" && <GbaView fileName={loaded.fileName} rom={loaded.rom} sha={sha} />}

            {loaded?.kind === "nds" && (
              <NdsView
                info={loaded.info}
                sha={sha}
                onGba={saveEmbeddedGba}
                onIcon={saveBannerIcon}
                pickedName={pickedIcon?.name ?? null}
                pickedPreview={pickedIcon ? previewHeaderIcon(loaded.info.gameCode, pickedIcon.image) : null}
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
                onPack={saveNds}
                headerIcon={headerIcon}
                setHeaderIcon={setHeaderIcon}
                usingPicture={bannerSource !== null}
                preview={headerPreview}
                pickedName={pickedIcon?.name ?? null}
                iconNote={loaded?.kind === "nds" ? null : iconNote}
                showFile={loaded?.kind !== "nds"}
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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={"btn " + (active ? "menu-on" : "menu-off")}>
      {children}
    </button>
  );
}

function CiaView({
  dossier,
  trim,
  setTrim,
  trimmedCount,
  outSize,
  sha,
  onRom,
  onJson,
  onFooter,
  onIcon,
}: {
  dossier: Dossier;
  trim: boolean;
  setTrim: (value: boolean) => void;
  trimmedCount: number;
  outSize: number;
  sha: string;
  onRom: () => void;
  onJson: () => void;
  onFooter: () => void;
  onIcon: () => void;
}) {
  const log = dossierLog(dossier);
  const offsets: [string, string][] = [
    ["CIA header", hex(dossier.offsets.ciaHeader)],
    ["NCCH", hex(dossier.offsets.ncch)],
    ["ExeFS", hex(dossier.offsets.exefs)],
    ["ROM start", hex(dossier.offsets.romStartInCode)],
    [".CAA footer", hex(dossier.offsets.footerInCode)],
    ["Icon", dossier.offsets.iconInFile >= 0 ? hex(dossier.offsets.iconInFile) : "—"],
  ];

  return (
    <div className="flex flex-col gap-4">
      {dossier.encrypted && (
        <p className="window px-4 py-3 text-sm font-bold text-red">This CIA looks encrypted. The ROM may not be playable.</p>
      )}

      <section className="window p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <IconPlate rgba={dossier.iconRgba} size={48} empty="No icon" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-muted">{dossier.fileName}</p>
            <h2 className="mt-1 text-2xl font-extrabold leading-tight">{dossier.smdh?.short || dossier.gba.title || "Untitled"}</h2>
            <p className="font-extrabold text-line">{dossier.gba.gameCode || "----"}</p>
            <p className="mt-2 text-sm font-semibold text-muted">{dossier.smdh?.publisher || "Publisher unknown"}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Stat label="ROM" value={formatBytes(outSize)} detail={dossier.gba.checksumOk ? "Header OK" : "Header checksum bad"} />
          <Stat label="Save" value={dossier.caa.save.name} detail={dossier.caa.save.rtc ? "Has a clock" : "No clock"} />
          <Stat label="Screen fix" value={ghostingLabel(dossier.caa.lcdGhosting)} detail={dossier.caa.magicOk ? "Footer found" : "Footer missing"} />
        </div>
      </section>

      <section className="window p-4">
        <label className="flex min-h-11 items-start gap-3 text-sm font-bold">
          <input
            type="checkbox"
            checked={trim}
            onChange={(event) => setTrim(event.target.checked)}
            className="mt-1 size-5 accent-red"
          />
          <span>
            Cut empty padding off the end
            <span className="mt-0.5 block font-semibold text-muted">
              {trimmedCount > 0
                ? `${formatBytes(trimmedCount)} of 0xFF. The download becomes ${formatBytes(outSize)}.`
                : "This ROM has no padding to cut."}
            </span>
          </span>
        </label>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Action icon={<Download className="size-4" />} onClick={onRom} primary>
            Download .gba
          </Action>
          <Action icon={<Download className="size-4" />} onClick={onIcon} disabled={!dossier.iconRgba}>
            Download icon
          </Action>
        </div>
        <p className="mt-3 break-all text-xs font-semibold text-muted">SHA-256 {sha || "…"}</p>
      </section>

      <details className="window px-4 py-3">
        <summary className="font-extrabold">Save config and offsets</summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {offsets.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-line-lite px-3 py-2">
              <p className="text-xs font-bold text-muted">{label}</p>
              <p className="text-sm font-extrabold text-line-deep">{value}</p>
            </div>
          ))}
        </div>
        <LutStrip lut={dossier.caa.videoLut} />
        <p className="mt-3 text-xs font-semibold leading-relaxed text-muted">
          {dossier.caa.save.alias}. Sleep combo {hex(dossier.caa.sleepCombo, 4)}.
        </p>
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-line-lite p-3 text-xs leading-relaxed">{log.join("\n")}</pre>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Action icon={<FileCode2 className="size-4" />} onClick={onJson}>
            Download save config
          </Action>
          <Action icon={<Download className="size-4" />} onClick={onFooter}>
            Download footer
          </Action>
        </div>
      </details>
    </div>
  );
}

function GbaView({ fileName, rom, sha }: { fileName: string; rom: Uint8Array; sha: string }) {
  const header = readGbaHeader(rom);
  return (
    <section className="window p-4">
      <p className="truncate text-xs font-bold text-muted">{fileName}</p>
      <h2 className="mt-1 text-2xl font-extrabold">{header.title || "Untitled"}</h2>
      <p className="font-extrabold text-line">{header.gameCode || "----"}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Stat label="Size" value={formatBytes(rom.length)} detail={hex(rom.length)} />
        <Stat label="Header" value={header.checksumOk ? "OK" : "Bad checksum"} detail={`Maker ${header.maker || "--"}`} />
        <Stat label="Logo" value={header.logoOk ? "Present" : "Missing"} detail={header.logoOk ? "Looks like a GBA ROM" : "Still packable"} />
      </div>
      <p className="mt-3 break-all text-xs font-semibold text-muted">SHA-256 {sha || "…"}</p>
    </section>
  );
}

function NdsView({
  info,
  sha,
  onGba,
  onIcon,
  pickedName,
  pickedPreview,
  iconNote,
  onPick,
  onClearPick,
  onPatch,
}: {
  info: NdsInfo;
  sha: string;
  onGba: () => void;
  onIcon: () => void;
  pickedName: string | null;
  pickedPreview: Uint8ClampedArray | null;
  iconNote: string | null;
  onPick: (file: File) => void;
  onClearPick: () => void;
  onPatch: () => void;
}) {
  const shown = info.files.slice(0, 8);
  return (
    <div className="flex flex-col gap-4">
      <section className="window p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <IconPlate rgba={info.iconRgba} size={32} empty="No icon" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-muted">{info.fileName}</p>
            <h2 className="mt-1 text-2xl font-extrabold leading-tight">{info.bannerTitle || info.title || "Untitled"}</h2>
            <p className="font-extrabold text-line">{info.gameCode || "----"}</p>
            <p className="mt-1 text-sm font-semibold text-muted">
              {info.unitCode === 2 ? "DSi" : "DS"} · {formatBytes(info.fileSize)} · {info.headerCrcOk ? "header OK" : "header checksum bad"}
            </p>
          </div>
        </div>
        {info.warnings.length > 0 && (
          <ul className="mt-3 list-disc pl-4 text-sm font-semibold text-muted">
            {info.warnings.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Action icon={<Download className="size-4" />} onClick={onGba} primary disabled={!info.gba}>
            {info.gba ? "Download .gba" : "No GBA ROM inside"}
          </Action>
          <Action icon={<Download className="size-4" />} onClick={onIcon} disabled={!info.iconRgba}>
            Download icon
          </Action>
        </div>
        {info.gba && <p className="mt-3 break-all text-xs font-semibold text-muted">GBA SHA-256 {sha || "…"}</p>}
      </section>

      {shown.length > 0 && (
        <section className="window p-4">
          <h2 className="font-extrabold">Files inside</h2>
          <ul className="mt-2 divide-y divide-line-lite text-sm font-semibold">
            {shown.map((file) => (
              <li key={`${file.name}:${file.start}`} className="flex items-baseline justify-between gap-3 py-2">
                <span className="break-all">{file.name}</span>
                <span className="shrink-0 text-xs text-muted">{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
          {info.files.length > shown.length && (
            <p className="mt-2 text-xs font-semibold text-muted">{info.files.length - shown.length} more files.</p>
          )}
        </section>
      )}

      <section className="window p-4">
        <h2 className="font-extrabold">Menu icon</h2>
        <p className="mt-1 text-sm font-semibold text-muted">Pick a picture. It becomes the 32×32 icon on the DS menu.</p>
        <HeaderIconFields
          preview={pickedPreview ?? info.iconRgba}
          previewSize={32}
          empty="No icon"
          pickedName={pickedName}
          iconNote={iconNote}
          showFile
          onPick={onPick}
          onClearPick={onClearPick}
        />
        <div className="mt-4">
          <Action icon={<Download className="size-4" />} onClick={onPatch} primary disabled={!pickedName}>
            Save DS file with this icon
          </Action>
        </div>
      </section>
    </div>
  );
}

function CarrierPanel({
  label,
  top,
  bottom,
  onPack,
  headerIcon,
  setHeaderIcon,
  usingPicture,
  preview,
  pickedName,
  iconNote,
  showFile,
  onPick,
  onClearPick,
}: {
  label: CarrierLabel;
  top: Uint8Array;
  bottom: Uint8Array;
  onPack: () => void;
  headerIcon: boolean;
  setHeaderIcon: (value: boolean) => void;
  usingPicture: boolean;
  preview: Uint8ClampedArray;
  pickedName: string | null;
  iconNote: string | null;
  showFile: boolean;
  onPick: (file: File) => void;
  onClearPick: () => void;
}) {
  return (
    <section className="window p-4">
      <div className="grid gap-4 lg:grid-cols-[13rem_1fr] lg:items-start">
        <div>
          <p className="font-extrabold text-line">Title card</p>
          <div className="mt-2 rounded-2xl bg-shell p-2">
            <Rgb555Canvas pixels={top} label="DS top screen" />
            <div className="my-1 h-2 rounded-full bg-ink/40" />
            <Rgb555Canvas pixels={bottom} label="DS bottom screen" />
          </div>
        </div>
        <div>
          <h2 className="text-lg font-extrabold">Make a DS file</h2>
          <p className="mt-1 text-sm font-semibold leading-relaxed text-muted">
            {label.title || "This ROM"} is stored inside as rom.gba. The DS shows the card on the left. It does not play the GBA game.
          </p>
          <p className="mt-2 text-xs font-bold text-muted">
            {label.gameCode || "----"} · {formatBytes(label.bytes)} · {label.checksumOk ? "header OK" : "header checksum bad"}
          </p>
          <label className="mt-4 flex min-h-11 items-start gap-3 text-sm font-bold">
            <input
              type="checkbox"
              checked={headerIcon}
              onChange={(event) => setHeaderIcon(event.target.checked)}
              className="mt-1 size-5 accent-red"
            />
            <span>
              Use a picture as the menu icon
              <span className="mt-0.5 block font-semibold text-muted">
                {headerIcon && usingPicture
                  ? "The DS menu will show this picture, in 16 colors."
                  : "Off uses a simple icon with the game code."}
              </span>
            </span>
          </label>
          <HeaderIconFields
            preview={preview}
            previewSize={32}
            empty="Icon"
            pickedName={showFile ? pickedName : null}
            iconNote={iconNote}
            showFile={showFile}
            onPick={onPick}
            onClearPick={onClearPick}
          />
          <div className="mt-4">
            <Action icon={<Download className="size-4" />} onClick={onPack} primary>
              Download .nds
            </Action>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeaderIconFields({
  preview,
  previewSize,
  empty,
  pickedName,
  iconNote,
  showFile,
  onPick,
  onClearPick,
}: {
  preview: Uint8ClampedArray | null;
  previewSize: number;
  empty: string;
  pickedName: string | null;
  iconNote: string | null;
  showFile: boolean;
  onPick: (file: File) => void;
  onClearPick: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-4">
      <IconPlate rgba={preview} size={previewSize} empty={empty} />
      {showFile && (
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <label className="btn btn-ghost cursor-pointer">
            Choose picture
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onPick(file);
              }}
            />
          </label>
          {pickedName ? (
            <button type="button" onClick={onClearPick} className="min-h-11 text-sm font-extrabold text-line-deep underline-offset-2 hover:underline">
              Remove {pickedName}
            </button>
          ) : (
            <p className="text-xs font-semibold text-muted">PNG, JPEG, GIF, or WebP.</p>
          )}
          {iconNote && <p className="text-sm font-bold text-red">{iconNote}</p>}
        </div>
      )}
    </div>
  );
}

function Rgb555Canvas({ pixels, label }: { pixels: Uint8Array; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(256, 192);
    for (let i = 0; i < 256 * 192; i++) {
      const color = pixels[i * 2]! | (pixels[i * 2 + 1]! << 8);
      const [r, g, b] = expand555(color);
      const o = i * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [pixels]);
  return <canvas ref={ref} width={256} height={192} className="pixelated h-auto w-full rounded-md bg-ink" aria-label={label} />;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg bg-line-lite px-3 py-3">
      <p className="text-xs font-bold text-muted">{label}</p>
      <p className="mt-1 text-sm font-extrabold leading-snug">{value}</p>
      <p className="mt-1 text-xs font-semibold text-line-deep">{detail}</p>
    </div>
  );
}

function Action({
  children,
  onClick,
  icon,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  icon: ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={"btn w-full " + (primary ? "btn-primary" : "btn-ghost")}>
      {icon}
      {children}
    </button>
  );
}

function IconPlate({ rgba, size, empty }: { rgba: Uint8ClampedArray | null; size: number; empty: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !rgba) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  }, [rgba, size]);
  if (!rgba) {
    return (
      <div className="flex h-28 w-28 items-center justify-center rounded-xl border-4 border-line bg-line-lite text-xs font-extrabold text-muted">
        {empty}
      </div>
    );
  }
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className="pixelated h-28 w-28 rounded-xl border-4 border-line bg-field"
      aria-label={`${size} by ${size} icon`}
    />
  );
}

function LutStrip({ lut }: { lut: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      image.data[i * 4] = lut[i * 3] ?? 0;
      image.data[i * 4 + 1] = lut[i * 3 + 1] ?? 0;
      image.data[i * 4 + 2] = lut[i * 3 + 2] ?? 0;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [lut]);
  return (
    <canvas
      ref={ref}
      width={256}
      height={1}
      className="pixelated mt-3 h-6 w-full rounded-md border-2 border-line"
      aria-label="Screen color table"
    />
  );
}

function CliPanel({ script, copied, onCopy }: { script: string; copied: boolean; onCopy: () => void }) {
  return (
    <section className="window overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-4 border-line-lite px-4 py-3">
        <div>
          <h2 className="font-extrabold">kgb.py</h2>
          <p className="text-xs font-semibold text-muted">Same CIA to GBA step, for a terminal. DS packing stays in the browser.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onCopy} className="btn btn-ghost">
            {copied ? "Copied" : "Copy"}
          </button>
          <a href="/kgb.py" download="kgb.py" className="btn btn-primary">
            Download
          </a>
        </div>
      </header>
      <div className="border-b-4 border-line-lite px-4 py-3 font-mono text-xs font-semibold leading-relaxed text-line-deep">
        <p>python3 kgb.py game.cia -o ./out</p>
        <p>python3 kgb.py game.cia --trim-ff</p>
      </div>
      <pre className="max-h-[28rem] overflow-auto px-4 py-3 text-xs leading-relaxed">{script || "Loading…"}</pre>
    </section>
  );
}
