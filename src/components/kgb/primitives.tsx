import { useEffect, useRef, type ReactNode } from "react";
import { expand555 } from "@/lib/kgb/screen";

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={"btn " + (active ? "menu-on" : "menu-off")}>
      {children}
    </button>
  );
}

export function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg bg-line-lite px-3 py-3">
      <p className="text-xs font-bold text-muted">{label}</p>
      <p className="mt-1 text-sm font-extrabold leading-snug">{value}</p>
      <p className="mt-1 text-xs font-semibold text-line-deep">{detail}</p>
    </div>
  );
}

export function Action({
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
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={"btn w-full " + (primary ? "btn-primary" : "btn-ghost")}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconPlate({
  rgba,
  size,
  empty,
}: {
  rgba: Uint8ClampedArray | null;
  size: number;
  empty: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !rgba) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
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
      role="img"
      aria-label={`${size} by ${size} icon`}
    />
  );
}

export function Rgb555Canvas({ pixels, label }: { pixels: Uint8Array; label: string }) {
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
  return (
    <canvas
      ref={ref}
      width={256}
      height={192}
      className="pixelated h-auto w-full rounded-md bg-ink"
      role="img"
      aria-label={label}
    />
  );
}

export function LutStrip({ lut }: { lut: Uint8Array }) {
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
      role="img"
      aria-label="Screen color table"
    />
  );
}
