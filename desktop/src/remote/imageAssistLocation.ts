export interface ImageAssistApproximateLocation {
  label: string;
  latitude: number;
  longitude: number;
}

const STORAGE_KEY = "somniq.image-assist.approximate-location.v1";

function validLocation(value: unknown): value is ImageAssistApproximateLocation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ImageAssistApproximateLocation>;
  return typeof candidate.label === "string"
    && candidate.label.trim().length > 0
    && candidate.label.length <= 80
    && typeof candidate.latitude === "number"
    && Number.isFinite(candidate.latitude)
    && candidate.latitude >= -90
    && candidate.latitude <= 90
    && typeof candidate.longitude === "number"
    && Number.isFinite(candidate.longitude)
    && candidate.longitude >= -180
    && candidate.longitude <= 180;
}

export function storedImageAssistLocation(): ImageAssistApproximateLocation | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return validLocation(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clearImageAssistLocation() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing and locked-down WebViews may refuse storage.
  }
}

function locationLabel(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const city = timeZone?.split("/").at(-1)?.replace(/_/g, " ").trim();
  return city || "Approximate location";
}

/**
 * Requests OS/browser location permission and immediately rounds the result to
 * one decimal place (roughly 11 km). Full-precision coordinates are never
 * persisted or sent to the gateway.
 */
export function requestImageAssistLocation(): Promise<ImageAssistApproximateLocation> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("location services are unavailable"));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          label: locationLabel(),
          latitude: Math.round(position.coords.latitude * 10) / 10,
          longitude: Math.round(position.coords.longitude * 10) / 10,
        };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
        } catch {
          // Publishing still works for this process even if storage is denied.
        }
        resolve(location);
      },
      (error) => reject(new Error(error.message || "location permission was denied")),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 86_400_000 },
    );
  });
}
