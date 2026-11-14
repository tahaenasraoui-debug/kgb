import type { RgbaImage } from "@/lib/kgb/nds";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIM = 4096;

/** Decode an image file with EXIF orientation applied, capped for DoS safety. */
export async function readImageFile(file: File): Promise<RgbaImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`That picture is ${(file.size / 1048576).toFixed(1)} MiB — please use one under 10 MiB.`);
  }
  // Prefer createImageBitmap with orientation handling (iPhone photos).
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        if (bitmap.width > MAX_IMAGE_DIM || bitmap.height > MAX_IMAGE_DIM) {
          throw new Error(`That picture is ${bitmap.width}x${bitmap.height} — please use one under 4096 px.`);
        }
        return bitmapToRgba(bitmap);
      } finally {
        bitmap.close();
      }
    }
  } catch (err) {
    if (err instanceof Error && /under (10 MiB|4096 px)/.test(err.message)) throw err;
    // Fall through to the <img> path on decoders without orientation support.
  }
  return readViaImageElement(file);
}

function bitmapToRgba(bitmap: ImageBitmap): RgbaImage {
  const limit = 256;
  const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return { rgba: data.data, width, height };
}

function readViaImageElement(file: File): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        if (img.naturalWidth > MAX_IMAGE_DIM || img.naturalHeight > MAX_IMAGE_DIM) {
          reject(new Error(`That picture is ${img.naturalWidth}x${img.naturalHeight} — please use one under 4096 px.`));
          return;
        }
        const limit = 256;
        const scale = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("Canvas is unavailable."));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve({ rgba: data.data, width: canvas.width, height: canvas.height });
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That picture could not be read."));
    };
    img.src = url;
  });
}
