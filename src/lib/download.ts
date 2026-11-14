export function downloadBlob(blob: Blob, name: string, revokeAfterMs = 4000): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a timer: revoking synchronously aborts the download in Firefox.
  window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

export function rgbaToPng(rgba: Uint8ClampedArray, size: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error(`Canvas is unavailable (${size}x${size}).`));
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed."))), "image/png");
  });
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Same-origin base for static assets (works under path-based preview rewrites). */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const b = base.endsWith("/") ? base : `${base}/`;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `${b}${p}`;
}
