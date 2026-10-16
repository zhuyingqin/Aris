export interface WallpaperAsset { blob: Blob; name: string }
const DB_NAME = "somniq-appearance-assets";
const ASSET_KEY = "chat-wallpaper";
async function assetStore(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<WallpaperAsset | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("assets");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open image storage"));
    request.onblocked = () => reject(new Error("Image storage is busy. Close other windows and retry."));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("assets", mode);
      const request = operation(transaction.objectStore("assets"));
      transaction.oncomplete = () => resolve(request.result as WallpaperAsset | undefined);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("Could not save image"));
    });
  } finally { db.close(); }
}
export const readWallpaperAsset = () => assetStore("readonly", (store) => store.get(ASSET_KEY));
export const writeWallpaperAsset = (asset?: WallpaperAsset) => assetStore("readwrite", (store) => asset ? store.put(asset, ASSET_KEY) : store.delete(ASSET_KEY));

export async function prepareWallpaper(file: File): Promise<WallpaperAsset> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Please use a PNG, JPEG, or WebP image.");
  if (file.size > 12 * 1024 * 1024) throw new Error("Image must be smaller than 12 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not read the image.")); image.src = url;
    });
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare image.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Re-encode the local raster image, keeping large originals out of preferences.
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare image.")), "image/webp", .88));
    return { blob, name: file.name };
  } finally { URL.revokeObjectURL(url); }
}
