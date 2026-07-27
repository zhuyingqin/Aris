import type { DeviceDescriptor } from "./types";

export function desktopShortCode(deviceId: string): string {
  const compact = deviceId.replaceAll("-", "");
  return compact.slice(-6).toUpperCase();
}

export function desktopDisplayLabel(
  desktop: DeviceDescriptor,
  pairedDesktops: readonly DeviceDescriptor[],
): string {
  const name = desktop.display_name.trim() || "SomniQ Desktop";
  const normalizedName = name.toLocaleLowerCase();
  const hasSameNamedPeer = pairedDesktops.some((peer) =>
    peer.device_id !== desktop.device_id &&
    (peer.display_name.trim() || "SomniQ Desktop").toLocaleLowerCase() === normalizedName
  );
  return hasSameNamedPeer ? `${name} · ${desktopShortCode(desktop.device_id)}` : name;
}
