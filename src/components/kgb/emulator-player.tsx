import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Volume2, VolumeX, Camera, Maximize, X, Gamepad2, Save, Download } from "lucide-react";
import { assetUrl } from "@/lib/download";
import type { MgbaInstance } from "@wasm-gaming/mgba-wasm";

export interface EmulatorPlayerProps {
  rom: Uint8Array;
  title: string;
  system: "gba" | "gb" | "gbc";
  onClose: () => void;
}

export function EmulatorPlayer({ rom, title, system, onClose }: EmulatorPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MgbaInstance | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [scanlines, setScanlines] = useState(false);
  const [hasSaveState, setHasSaveState] = useState(false);
  const [saveStateBytes, setSaveStateBytes] = useState<Uint8Array | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  const showNotify = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification((prev) => (prev === msg ? null : prev)), 2000);
  };

  useEffect(() => {
    let cancelled = false;
    let engine: MgbaInstance | null = null;

    async function initEmulator() {
      if (!canvasRef.current) return;
      try {
        setLoading(true);
        setError(null);

        // Dynamically import to ensure SSR-safe execution
        const { load } = await import("@wasm-gaming/mgba-wasm");

        if (cancelled) return;

        const jsUrl = assetUrl("mgba/mgba.js");
        const wasmUrl = assetUrl("mgba/mgba.wasm");

        engine = await load({
          canvasEl: canvasRef.current,
          assets: { rom },
          jsUrl,
          wasmUrl,
          options: {
            system: system === "gba" ? "gba" : "gb",
            renderFilter: "pixelated",
            aspect: "native",
            volume: 1,
            gamepads: true,
          },
        });

        if (cancelled) {
          engine.destroy();
          return;
        }

        engineRef.current = engine;
        engine.start();
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || "Failed to start emulator");
          setLoading(false);
        }
      }
    }

    initEmulator();

    return () => {
      cancelled = true;
      if (engineRef.current) {
        try {
          engineRef.current.destroy();
        } catch {
          /* ignore shutdown errors */
        }
        engineRef.current = null;
      }
    };
  }, [rom, system]);

  const togglePause = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (paused) {
      engine.resume();
      setPaused(false);
      showNotify("Resumed");
    } else {
      engine.pause();
      setPaused(true);
      showNotify("Paused");
    }
  };

  const handleReset = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.reset();
    showNotify("Reset Game");
  };

  const toggleMute = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (muted) {
      engine.config.write("volume", volume || 1);
      setMuted(false);
    } else {
      engine.config.write("volume", 0);
      setMuted(true);
    }
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    const engine = engineRef.current;
    if (!engine) return;
    if (v > 0 && muted) setMuted(false);
    engine.config.write("volume", v);
  };

  const handleSaveState = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const state = await engine.saveState();
      setSaveStateBytes(state);
      setHasSaveState(true);
      showNotify("State Saved");
    } catch (err) {
      showNotify(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleLoadState = async () => {
    const engine = engineRef.current;
    if (!engine || !saveStateBytes) return;
    try {
      await engine.loadState(saveStateBytes);
      showNotify("State Loaded");
    } catch (err) {
      showNotify(`Load failed: ${(err as Error).message}`);
    }
  };

  const handleScreenshot = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const blob = await engine.screenshot();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}_screenshot.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showNotify("Screenshot captured");
    } catch {
      showNotify("Screenshot failed");
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Virtual controller button press helper
  const sendKey = (code: string, type: "keydown" | "keyup") => {
    const evt = new KeyboardEvent(type, {
      code,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(evt);
  };

  const systemLabel = system === "gbc" ? "Game Boy Color" : system === "gb" ? "Game Boy" : "Game Boy Advance";
  const systemBadge = system.toUpperCase();

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col items-center rounded-xl border border-line bg-surface-raised p-4 shadow-2xl"
    >
      {/* Header bar */}
      <div className="flex w-full items-center justify-between border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <Gamepad2 className="size-5 text-red" />
          <div className="min-w-0">
            <h3 className="truncate font-extrabold leading-tight">{title}</h3>
            <div className="flex items-center gap-2 text-xs font-semibold text-muted">
              <span className="rounded bg-line/20 px-1.5 py-0.5 text-[10px] font-bold text-red">{systemBadge}</span>
              <span>mGBA Core (WASM)</span>
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface hover:border-red hover:text-red active:translate-y-0.5"
          title="Close Emulator"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Screen container */}
      <div className="relative my-4 flex w-full max-w-2xl items-center justify-center overflow-hidden rounded-lg border-2 border-line bg-black p-2 shadow-inner">
        {loading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 p-4 text-center">
            <div className="size-8 animate-spin rounded-full border-4 border-red border-t-transparent" />
            <p className="mt-3 text-sm font-bold text-line">Loading {systemLabel} ROM…</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-4 text-center">
            <p className="font-extrabold text-red">Failed to boot emulator</p>
            <p className="mt-1 text-xs text-muted">{error}</p>
            <button
              onClick={handleReset}
              className="mt-3 rounded border border-line bg-surface px-3 py-1 text-xs font-bold hover:border-red"
            >
              Retry
            </button>
          </div>
        )}

        {notification && (
          <div className="pointer-events-none absolute top-4 z-30 rounded bg-red/90 px-3 py-1 text-xs font-black tracking-wider text-black uppercase shadow-lg">
            {notification}
          </div>
        )}

        {/* Emulated Canvas */}
        <canvas
          ref={canvasRef}
          className="h-auto max-h-[70vh] w-full object-contain"
          style={{
            imageRendering: "pixelated",
          }}
        />

        {/* Scanlines overlay effect */}
        {scanlines && (
          <div
            className="pointer-events-none absolute inset-0 z-10 opacity-25"
            style={{
              backgroundImage: "linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.75) 50%)",
              backgroundSize: "100% 4px",
            }}
          />
        )}
      </div>

      {/* Toolbar Controls */}
      <div className="flex w-full max-w-2xl flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="flex items-center gap-1">
          <button
            onClick={togglePause}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold hover:border-red active:translate-y-0.5"
            title={paused ? "Resume (Space)" : "Pause (Space)"}
          >
            {paused ? <Play className="size-3.5 text-red" /> : <Pause className="size-3.5 text-muted" />}
            <span>{paused ? "Resume" : "Pause"}</span>
          </button>

          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold hover:border-red active:translate-y-0.5"
            title="Reset Game"
          >
            <RotateCcw className="size-3.5 text-muted" />
            <span>Reset</span>
          </button>

          <button
            onClick={handleSaveState}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold hover:border-red active:translate-y-0.5"
            title="Save Quick State"
          >
            <Save className="size-3.5 text-muted" />
            <span>Save State</span>
          </button>

          <button
            onClick={handleLoadState}
            disabled={!hasSaveState}
            className={`flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold active:translate-y-0.5 ${
              hasSaveState ? "hover:border-red" : "opacity-40 cursor-not-allowed"
            }`}
            title="Load Quick State"
          >
            <Download className="size-3.5 text-muted" />
            <span>Load State</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Scanline toggle */}
          <button
            onClick={() => setScanlines(!scanlines)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold active:translate-y-0.5 ${
              scanlines ? "border-red text-red bg-red/10" : "border-line bg-surface text-muted"
            }`}
            title="Toggle CRT Scanline Effect"
          >
            CRT
          </button>

          {/* Screenshot */}
          <button
            onClick={handleScreenshot}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:border-red hover:text-red active:translate-y-0.5"
            title="Screenshot"
          >
            <Camera className="size-4" />
          </button>

          {/* Volume control */}
          <div className="flex items-center gap-1">
            <button
              onClick={toggleMute}
              className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:border-red hover:text-red active:translate-y-0.5"
              title={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="h-1.5 w-16 accent-red cursor-pointer"
              title="Volume"
            />
          </div>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:border-red hover:text-red active:translate-y-0.5"
            title="Fullscreen"
          >
            <Maximize className="size-4" />
          </button>
        </div>
      </div>

      {/* Virtual D-pad / Buttons & Key Reference */}
      <div className="mt-4 grid w-full max-w-2xl grid-cols-1 gap-4 rounded-lg border border-line bg-surface p-3 text-xs sm:grid-cols-2">
        {/* On-screen Touch / Click Controller */}
        <div className="flex flex-col items-center justify-center gap-2 border-b border-line pb-3 sm:border-b-0 sm:border-r sm:pr-4 sm:pb-0">
          <p className="font-extrabold text-muted">Virtual Gamepad (Click / Touch)</p>
          <div className="flex w-full items-center justify-around gap-2">
            {/* D-Pad */}
            <div className="grid grid-cols-3 gap-1">
              <div />
              <button
                onMouseDown={() => sendKey("ArrowUp", "keydown")}
                onMouseUp={() => sendKey("ArrowUp", "keyup")}
                onTouchStart={() => sendKey("ArrowUp", "keydown")}
                onTouchEnd={() => sendKey("ArrowUp", "keyup")}
                className="flex size-8 items-center justify-center rounded border border-line bg-surface-raised font-bold active:bg-red active:text-black"
              >
                ▲
              </button>
              <div />
              <button
                onMouseDown={() => sendKey("ArrowLeft", "keydown")}
                onMouseUp={() => sendKey("ArrowLeft", "keyup")}
                onTouchStart={() => sendKey("ArrowLeft", "keydown")}
                onTouchEnd={() => sendKey("ArrowLeft", "keyup")}
                className="flex size-8 items-center justify-center rounded border border-line bg-surface-raised font-bold active:bg-red active:text-black"
              >
                ◀
              </button>
              <div className="size-8" />
              <button
                onMouseDown={() => sendKey("ArrowRight", "keydown")}
                onMouseUp={() => sendKey("ArrowRight", "keyup")}
                onTouchStart={() => sendKey("ArrowRight", "keydown")}
                onTouchEnd={() => sendKey("ArrowRight", "keyup")}
                className="flex size-8 items-center justify-center rounded border border-line bg-surface-raised font-bold active:bg-red active:text-black"
              >
                ▶
              </button>
              <div />
              <button
                onMouseDown={() => sendKey("ArrowDown", "keydown")}
                onMouseUp={() => sendKey("ArrowDown", "keyup")}
                onTouchStart={() => sendKey("ArrowDown", "keydown")}
                onTouchEnd={() => sendKey("ArrowDown", "keyup")}
                className="flex size-8 items-center justify-center rounded border border-line bg-surface-raised font-bold active:bg-red active:text-black"
              >
                ▼
              </button>
              <div />
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
                <button
                  onMouseDown={() => sendKey("KeyZ", "keydown")}
                  onMouseUp={() => sendKey("KeyZ", "keyup")}
                  onTouchStart={() => sendKey("KeyZ", "keydown")}
                  onTouchEnd={() => sendKey("KeyZ", "keyup")}
                  className="flex size-9 items-center justify-center rounded-full border-2 border-line bg-surface-raised font-extrabold active:bg-red active:text-black"
                >
                  B
                </button>
                <button
                  onMouseDown={() => sendKey("KeyX", "keydown")}
                  onMouseUp={() => sendKey("KeyX", "keyup")}
                  onTouchStart={() => sendKey("KeyX", "keydown")}
                  onTouchEnd={() => sendKey("KeyX", "keyup")}
                  className="flex size-9 items-center justify-center rounded-full border-2 border-red bg-surface-raised font-extrabold text-red active:bg-red active:text-black"
                >
                  A
                </button>
              </div>

              {system === "gba" && (
                <div className="flex items-center gap-2">
                  <button
                    onMouseDown={() => sendKey("KeyA", "keydown")}
                    onMouseUp={() => sendKey("KeyA", "keyup")}
                    onTouchStart={() => sendKey("KeyA", "keydown")}
                    onTouchEnd={() => sendKey("KeyA", "keyup")}
                    className="rounded border border-line bg-surface-raised px-2.5 py-1 text-[10px] font-bold active:bg-red active:text-black"
                  >
                    L
                  </button>
                  <button
                    onMouseDown={() => sendKey("KeyS", "keydown")}
                    onMouseUp={() => sendKey("KeyS", "keyup")}
                    onTouchStart={() => sendKey("KeyS", "keydown")}
                    onTouchEnd={() => sendKey("KeyS", "keyup")}
                    className="rounded border border-line bg-surface-raised px-2.5 py-1 text-[10px] font-bold active:bg-red active:text-black"
                  >
                    R
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onMouseDown={() => sendKey("ShiftRight", "keydown")}
                  onMouseUp={() => sendKey("ShiftRight", "keyup")}
                  onTouchStart={() => sendKey("ShiftRight", "keydown")}
                  onTouchEnd={() => sendKey("ShiftRight", "keyup")}
                  className="rounded-full border border-line bg-surface-raised px-2 py-0.5 text-[9px] font-bold uppercase active:bg-red active:text-black"
                >
                  Select
                </button>
                <button
                  onMouseDown={() => sendKey("Enter", "keydown")}
                  onMouseUp={() => sendKey("Enter", "keyup")}
                  onTouchStart={() => sendKey("Enter", "keydown")}
                  onTouchEnd={() => sendKey("Enter", "keyup")}
                  className="rounded-full border border-line bg-surface-raised px-2 py-0.5 text-[9px] font-bold uppercase active:bg-red active:text-black"
                >
                  Start
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Keyboard Map Reference */}
        <div className="flex flex-col justify-center gap-1.5 pl-0 sm:pl-2">
          <p className="font-extrabold text-muted">Keyboard Controls</p>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] font-semibold text-muted">
            <div>
              <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">Arrow Keys</kbd>
              <span className="ml-1.5">D-Pad</span>
            </div>
            <div>
              <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">X</kbd>
              <span className="ml-1.5">A Button</span>
            </div>
            <div>
              <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">Z</kbd>
              <span className="ml-1.5">B Button</span>
            </div>
            {system === "gba" && (
              <div>
                <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">A / S</kbd>
                <span className="ml-1.5">L / R Bumpers</span>
              </div>
            )}
            <div>
              <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">Enter</kbd>
              <span className="ml-1.5">Start</span>
            </div>
            <div>
              <kbd className="rounded border border-line bg-surface-raised px-1 py-0.5 text-line">Shift</kbd>
              <span className="ml-1.5">Select</span>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-muted">
            🎮 Gamepads connected via USB or Bluetooth are automatically detected.
          </p>
        </div>
      </div>
    </div>
  );
}
