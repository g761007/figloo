import type { Rect } from "@figloo/protocol";

/** Longest edge Claude takes in without downscaling; larger captures only cost bytes. */
export const MAX_IMAGE_EDGE = 1568;

export interface CropPlan {
  /** Source rectangle in image pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output size after scaling to fit MAX_IMAGE_EDGE. */
  width: number;
  height: number;
}

/**
 * Maps a crop in viewport CSS pixels onto the captured image, which is in device pixels, and scales
 * the result down to fit maxEdge.
 */
export function planCrop(crop: Rect, viewport: { width: number; height: number }, image: { width: number; height: number }, maxEdge = MAX_IMAGE_EDGE): CropPlan {
  const scale = image.width / viewport.width;
  const x = Math.max(0, Math.min(crop.x, viewport.width));
  const y = Math.max(0, Math.min(crop.y, viewport.height));
  const right = Math.max(x, Math.min(crop.x + crop.width, viewport.width));
  const bottom = Math.max(y, Math.min(crop.y + crop.height, viewport.height));
  const sx = Math.round(x * scale);
  const sy = Math.round(y * scale);
  const sw = Math.max(1, Math.min(image.width - sx, Math.round((right - x) * scale)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.round((bottom - y) * scale)));
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)) };
}

/** Crops and scales a captured PNG in the service worker and returns it as base64 JPEG. */
export async function cropCapture(dataUrl: string, crop: Rect, viewport: { width: number; height: number }): Promise<{ data: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const plan = planCrop(crop, viewport, { width: bitmap.width, height: bitmap.height });
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  canvas.getContext("2d")!.drawImage(bitmap, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
  bitmap.close();
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < jpeg.length; i += 0x8000) binary += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
  return { data: btoa(binary), width: plan.width, height: plan.height };
}
