export interface ImagePoint { x: number; y: number }
export type ImageRegion = ImagePoint[];

/** SVG's xMidYMid/meet letterboxing, in original image pixels. */
export function imagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number, clamp = false): ImagePoint | null {
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!clamp && (x < 0 || y < 0 || x > width || y > height))) return null;
  return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
}

export function regionArea(points: ImageRegion): number {
  return Math.abs(points.reduce((sum, point, i) => { const next = points[(i + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
}
export const rectangleRegion = (a: ImagePoint, b: ImagePoint): ImageRegion => [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];

export function selectionMask(width: number, height: number, regions: ImageRegion[]): string {
  if (!regions.length) throw new Error("请先圈选需要修改的区域。 / Select an area first.");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建圈选蒙版。 / Cannot create a selection mask.");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "destination-out";
  for (const region of regions) {
    ctx.beginPath(); region.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); ctx.fill();
  }
  // Rasterized polygon edges become binary, so protected pixels are exact.
  const pixels = ctx.getImageData(0, 0, width, height); let selected = 0;
  for (let i = 3; i < pixels.data.length; i += 4) { const alpha = pixels.data[i] < 128 ? 0 : 255; pixels.data[i] = alpha; if (alpha === 0) selected++; }
  if (!selected) throw new Error("圈选区域太小，请重新圈选。 / Select a larger area.");
  ctx.putImageData(pixels, 0, 0);
  const encoded = canvas.toDataURL("image/png").split(",")[1];
  if (!encoded || encoded.length >= 4 * 1024 * 1024 * 4 / 3) throw new Error("圈选蒙版超过 4 MB，请缩小图片。 / The mask exceeds 4 MB.");
  return encoded;
}
