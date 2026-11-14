import { Download, FileCode2, Gamepad2 } from "lucide-react";
import { assetUrl } from "@/lib/download";
import {
  dossierLog,
  formatBytes,
  ghostingLabel,
  hex,
} from "@/lib/kgb/format";
import { readGbaHeader } from "@/lib/kgb/gba";
import { type NdsInfo, type RgbaImage } from "@/lib/kgb/nds";
import { type CarrierLabel, type Dossier } from "@/lib/kgb/types";
import { describeGbaSize } from "@/lib/kgb/validate";
import { Action, IconPlate, LutStrip, Rgb555Canvas, Stat } from "./primitives";

export function HeaderIconFields({
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
            <button
              type="button"
              onClick={onClearPick}
              className="min-h-11 text-sm font-extrabold text-line-deep underline-offset-2 hover:underline"
            >
              Remove {pickedName}
            </button>
          ) : (
            <p className="text-xs font-semibold text-muted">PNG, JPEG, GIF, or WebP. Under 10 MiB.</p>
          )}
          {iconNote && <p className="text-sm font-bold text-red">{iconNote}</p>}
        </div>
      )}
    </div>
  );
}

export function CiaView({
  dossier,
  trim,
  setTrim,
  trimmedCount,
  outSize,
  sha,
  onRom,
  onDownloadGb,
  onDownloadGbc,
  onDownloadGba,
  onPlay,
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
  onDownloadGb?: () => void;
  onDownloadGbc?: () => void;
  onDownloadGba?: () => void;
  onPlay?: () => void;
  onJson: () => void;
  onFooter: () => void;
  onIcon: () => void;
}) {
  const { log, offsets } = dossierLogView(dossier);
  const isGb = dossier.system === "gb" || dossier.system === "gbc";
  return (
    <div className="flex flex-col gap-4">
      {dossier.encrypted && (
        <p className="window px-4 py-3 text-sm font-bold text-red">
          This CIA looks encrypted. The ROM may not be playable. Rebuild it as NoCrypto with vcoven or
          NSUI (decrypt personal dumps with GodMode9 first), then try again.
        </p>
      )}

      <section className="window p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <IconPlate rgba={dossier.iconRgba} size={48} empty="No icon" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-muted">{dossier.fileName}</p>
            <h2 className="mt-1 text-2xl font-extrabold leading-tight">
              {dossier.smdh?.short || dossier.gb?.title || dossier.gba.title || "Untitled"}
            </h2>
            <p className="font-extrabold text-line">
              {dossier.system === "gbc"
                ? "GAME BOY COLOR"
                : dossier.system === "gb"
                  ? "GAME BOY"
                  : dossier.gba.gameCode || "----"}
            </p>
            <p className="mt-2 text-sm font-semibold text-muted">
              {dossier.smdh?.publisher || (isGb ? "Virtual Console" : "Publisher unknown")}
            </p>
          </div>
        </div>
        {isGb && dossier.gb ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Stat
              label="Format"
              value={dossier.system === "gbc" ? "Game Boy Color" : "Game Boy"}
              detail={
                dossier.gb.cgbSupported
                  ? dossier.gb.cgbOnly
                    ? "Color only (CGB)"
                    : "Dual-mode (DMG + CGB)"
                  : "Original monochrome DMG"
              }
            />
            <Stat
              label="Cartridge"
              value={dossier.gb.cartridgeTypeName}
              detail={dossier.gb.checksumOk ? "Header checksum OK" : "Checksum mismatch"}
            />
            <Stat
              label="ROM Size"
              value={formatBytes(outSize)}
              detail={dossier.gb.ramSizeBytes ? `RAM ${formatBytes(dossier.gb.ramSizeBytes)}` : "No on-cart RAM"}
            />
          </div>
        ) : (
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Stat
              label="ROM"
              value={formatBytes(outSize)}
              detail={dossier.gba.checksumOk ? "Header OK" : "Header checksum bad"}
            />
            <Stat
              label="Save"
              value={dossier.caa.save.name}
              detail={dossier.caa.save.rtc ? "Has a clock" : "No clock"}
            />
            <Stat
              label="Screen fix"
              value={ghostingLabel(dossier.caa.lcdGhosting)}
              detail={dossier.caa.magicOk ? "Footer found" : "Footer missing"}
            />
          </div>
        )}
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
          {dossier.system === "gb" && (
            <>
              <Action icon={<Download className="size-4" />} onClick={onDownloadGb || onRom} primary>
                Download .gb
              </Action>
              <Action icon={<Download className="size-4" />} onClick={onDownloadGbc || onRom}>
                Download .gbc
              </Action>
              <Action icon={<Download className="size-4" />} onClick={onDownloadGba || onRom}>
                Download .gba
              </Action>
            </>
          )}
          {dossier.system === "gbc" && (
            <>
              <Action icon={<Download className="size-4" />} onClick={onDownloadGbc || onRom} primary>
                Download .gbc
              </Action>
              <Action icon={<Download className="size-4" />} onClick={onDownloadGba || onRom}>
                Download .gba
              </Action>
            </>
          )}
          {(!dossier.system || dossier.system === "gba") && (
            <Action icon={<Download className="size-4" />} onClick={onDownloadGba || onRom} primary>
              Download .gba
            </Action>
          )}
          {onPlay && (
            <Action icon={<Gamepad2 className="size-4" />} onClick={onPlay}>
              Play in Browser
            </Action>
          )}
          <Action icon={<Download className="size-4" />} onClick={onIcon} disabled={!dossier.iconRgba}>
            Download icon
          </Action>
        </div>
        <p className="mt-3 break-all text-xs font-semibold text-muted">SHA-256 {sha || "…"}</p>
      </section>

      <details className="window px-4 py-3">
        <summary className="font-extrabold">{isGb ? "RomFS and cartridge config" : "Save config and offsets"}</summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {offsets.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-line-lite px-3 py-2">
              <p className="text-xs font-bold text-muted">{label}</p>
              <p className="text-sm font-extrabold text-line-deep">{value}</p>
            </div>
          ))}
        </div>
        {dossier.caa?.videoLut?.length > 0 && <LutStrip lut={dossier.caa.videoLut} />}
        {!isGb && dossier.caa && (
          <p className="mt-3 text-xs font-semibold leading-relaxed text-muted">
            {dossier.caa.save.alias}. Sleep combo {hex(dossier.caa.sleepCombo, 4)}.
          </p>
        )}
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-line-lite p-3 text-xs leading-relaxed">
          {log.join("\n")}
        </pre>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Action icon={<FileCode2 className="size-4" />} onClick={onJson}>
            Download save config
          </Action>
          {dossier.caa?.magicOk && (
            <Action icon={<Download className="size-4" />} onClick={onFooter}>
              Download footer
            </Action>
          )}
        </div>
      </details>
    </div>
  );
}

function dossierLogView(dossier: Dossier): { log: string[]; offsets: [string, string][] } {
  return { log: dossierLog(dossier), offsets: offsetCells(dossier) };
}

function offsetCells(dossier: Dossier): [string, string][] {
  return [
    ["CIA header", hex(dossier.offsets.ciaHeader)],
    ["NCCH", hex(dossier.offsets.ncch)],
    ["ExeFS", hex(dossier.offsets.exefs)],
    ["ROM start", hex(dossier.offsets.romStartInCode)],
    [".CAA footer", hex(dossier.offsets.footerInCode)],
    ["Icon", dossier.offsets.iconInFile >= 0 ? hex(dossier.offsets.iconInFile) : "—"],
  ];
}

export function GbaView({ fileName, rom, sha, onPlay }: { fileName: string; rom: Uint8Array; sha: string; onPlay?: () => void }) {
  const header = readGbaHeader(rom);
  return (
    <section className="window p-4">
      <p className="truncate text-xs font-bold text-muted">{fileName}</p>
      <h2 className="mt-1 text-2xl font-extrabold">{header.title || "Untitled"}</h2>
      <p className="font-extrabold text-line">{header.gameCode || "----"}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Stat label="Size" value={formatBytes(rom.length)} detail={hex(rom.length)} />
        <Stat
          label="Header"
          value={header.checksumOk ? "OK" : "Bad checksum"}
          detail={`Maker ${header.maker || "--"}`}
        />
        <Stat
          label="Logo"
          value={header.logoOk ? "Present" : "Missing"}
          detail={header.logoOk ? "Looks like a GBA ROM" : "Still packable"}
        />
      </div>
      {onPlay && (
        <div className="mt-4">
          <Action icon={<Gamepad2 className="size-4" />} onClick={onPlay}>
            Play in Browser
          </Action>
        </div>
      )}
      <p className="mt-3 text-xs font-semibold leading-relaxed text-muted">{describeGbaSize(rom.length).detail}</p>
      <p className="mt-2 break-all text-xs font-semibold text-muted">SHA-256 {sha || "…"}</p>
    </section>
  );
}

export function NdsView({
  info,
  sha,
  busy,
  onGba,
  onIcon,
  onDownloadFile,
  onDownloadAll,
  pickedName,
  pickedPreview,
  iconNote,
  onPick,
  onClearPick,
  onPatch,
}: {
  info: NdsInfo;
  sha: string;
  busy: boolean;
  onGba: () => void;
  onIcon: () => void;
  onDownloadFile: (index: number) => void;
  onDownloadAll: () => void;
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
            <h2 className="mt-1 text-2xl font-extrabold leading-tight">
              {info.bannerTitle || info.title || "Untitled"}
            </h2>
            <p className="font-extrabold text-line">{info.gameCode || "----"}</p>
            <p className="mt-1 text-sm font-semibold text-muted">
              {info.unitCode === 2 ? "DSi" : "DS"} · {formatBytes(info.fileSize)} ·{" "}
              {info.headerCrcOk ? "header OK" : "header checksum bad"}
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
          <Action icon={<Download className="size-4" />} onClick={onGba} primary disabled={!info.gba || busy}>
            {info.gba ? "Download .gba" : "No GBA ROM inside"}
          </Action>
          <Action icon={<Download className="size-4" />} onClick={onIcon} disabled={!info.iconRgba}>
            Download icon
          </Action>
        </div>
        {info.gba && <p className="mt-3 break-all text-xs font-semibold text-muted">GBA SHA-256 {sha || "…"}</p>}
      </section>

      <details className="window px-4 py-3">
        <summary className="font-extrabold">Cartridge layout</summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(
            [
              ["ARM9", `${hex(info.arm9Offset)} · ${formatBytes(info.arm9Size)}`],
              ["ARM7", `${hex(info.arm7Offset)} · ${formatBytes(info.arm7Size)}`],
              ["FNT", `${hex(info.fntOffset)} · ${formatBytes(info.fntSize)}`],
              ["FAT", `${hex(info.fatOffset)} · ${formatBytes(info.fatSize)}`],
              ["Banner", `${hex(info.bannerOffset)} · v${info.bannerVersion} ${info.bannerCrcOk ? "CRC OK" : "CRC bad"}`],
              ["ROM size field", hex(info.romSizeField)],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg bg-line-lite px-3 py-2">
              <p className="text-xs font-bold text-muted">{label}</p>
              <p className="text-sm font-extrabold text-line-deep">{value}</p>
            </div>
          ))}
        </div>
      </details>

      {shown.length > 0 && (
        <section className="window p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-extrabold">Files inside</h2>
            {info.files.length > 1 && (
              <button
                type="button"
                onClick={onDownloadAll}
                disabled={busy}
                className="min-h-11 px-2 text-xs font-extrabold text-line-deep underline-offset-2 hover:underline disabled:opacity-45"
              >
                Download all
              </button>
            )}
          </div>
          <ul className="mt-2 divide-y divide-line-lite text-sm font-semibold">
            {shown.map((file, i) => (
              <li key={`${file.name}:${file.start}`} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 break-all">{file.name}</span>
                <span className="shrink-0 text-xs text-muted">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => onDownloadFile(i)}
                  disabled={busy || file.size > 8 * 1024 * 1024}
                  title={file.size > 8 * 1024 * 1024 ? "Too large to extract in the browser view" : `Extract ${file.name}`}
                  className="shrink-0 rounded-lg border-2 border-line px-2 py-1 text-xs font-extrabold text-line-deep disabled:opacity-45"
                >
                  <Download className="size-3" aria-hidden="true" />
                </button>
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
        <p className="mt-1 text-sm font-semibold text-muted">
          Pick a picture. It becomes the 32×32 icon on the DS menu.
        </p>
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
          <Action icon={<Download className="size-4" />} onClick={onPatch} primary disabled={!pickedName || busy}>
            Save DS file with this icon
          </Action>
        </div>
      </section>
    </div>
  );
}

export function CarrierPanel({
  label,
  top,
  bottom,
  busy,
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
  busy: boolean;
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
            {label.title || "This ROM"} is stored inside as rom.gba. The DS shows the card on the left. It
            does not play the GBA game.
          </p>
          <p className="mt-2 text-xs font-bold text-muted">
            {label.gameCode || "----"} · {formatBytes(label.bytes)} ·{" "}
            {label.checksumOk ? "header OK" : "header checksum bad"}
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
            <Action icon={<Download className="size-4" />} onClick={onPack} primary disabled={busy}>
              {busy ? "Working…" : "Download .nds"}
            </Action>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CliPanel({
  script,
  scriptError,
  onRetry,
  copied,
  onCopy,
}: {
  script: string;
  scriptError: string | null;
  onRetry: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section className="window overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-4 border-line-lite px-4 py-3">
        <div>
          <h2 className="font-extrabold">kgb.py</h2>
          <p className="text-xs font-semibold text-muted">
            Same CIA to GBA step, for a terminal. DS packing stays in the browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onCopy} className="btn btn-ghost" disabled={!script}>
            {copied ? "Copied" : "Copy"}
          </button>
          <a href={assetUrl("kgb.py")} download="kgb.py" className="btn btn-primary">
            Download
          </a>
        </div>
      </header>
      <div className="border-b-4 border-line-lite px-4 py-3 font-mono text-xs font-semibold leading-relaxed text-line-deep">
        <p>python3 kgb.py game.cia -o ./out</p>
        <p>python3 kgb.py game.cia --trim-ff</p>
      </div>
      {scriptError ? (
        <div className="px-4 py-3 text-sm font-semibold">
          <p className="text-red">{scriptError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 text-sm font-extrabold text-line-deep underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </div>
      ) : (
        <pre className="max-h-[28rem] overflow-auto px-4 py-3 text-xs leading-relaxed">
          {script || "Loading…"}
        </pre>
      )}
    </section>
  );
}

export function QueueBar({
  entries,
  activeId,
  onSelect,
  onRemove,
  onClear,
}: {
  entries: { id: number; name: string; kind: string }[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="window px-4 py-3" aria-label="Loaded files">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-extrabold text-line-deep">
          Files ({entries.length}/{20})
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="min-h-11 px-2 text-xs font-extrabold text-line-deep underline-offset-2 hover:underline"
        >
          Clear all
        </button>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(e.id)}
              aria-current={e.id === activeId ? "true" : undefined}
              className={
                "max-w-44 truncate rounded-xl border-2 px-2 py-1 text-xs font-extrabold " +
                (e.id === activeId ? "border-line bg-gold text-ink" : "border-line-lite bg-field text-line-deep")
              }
            >
              {e.name}
            </button>
            <button
              type="button"
              onClick={() => onRemove(e.id)}
              aria-label={`Remove ${e.name}`}
              className="rounded-lg px-1 text-xs font-extrabold text-muted hover:text-red"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
