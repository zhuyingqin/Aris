import type { DeviceDescriptor } from "./types";

/** Longest model string worth putting in a device list row. */
const MAX_MODEL_LENGTH = 40;

/**
 * Tokens that sit where a model belongs but name no device.
 *
 * `K` is the placeholder Chrome 110+ substitutes for the real model when it
 * reduces the Android user agent, so it is by far the most common value here —
 * treating it as a model would label most Android phones "K".
 */
const NON_MODEL_TOKENS = new Set(["k", "mobile", "tablet", "wv", "unknown"]);

function usableModel(value: string | undefined | null): string | null {
  const model = value?.trim() ?? "";
  if (!model || model.length > MAX_MODEL_LENGTH) return null;
  if (NON_MODEL_TOKENS.has(model.toLowerCase())) return null;
  return model;
}

/** Pulls the model out of an Android user agent that still carries one. */
export function androidModelFromUserAgent(userAgent: string): string | null {
  const match = /Android\s+[\d._]+;\s*([^;)]+)/i.exec(userAgent);
  if (!match) return null;
  // Older agents append a build tag to the model: "M2102J2SC Build/TKQ1...".
  return usableModel(match[1].replace(/\bBuild\/.*$/i, ""));
}

/** The subset of `navigator.userAgentData` this module needs. */
export interface HighEntropyUserAgent {
  getHighEntropyValues(hints: string[]): Promise<{ model?: string }>;
}

/**
 * Best available name for this browser, asking for the Android model when the
 * platform will give it.
 *
 * Chrome froze the model in the user-agent string, so on most Android phones
 * client hints are the only remaining source. The value is requested purely to
 * label the user's own device in their own paired list and travels only to
 * their own computer.
 */
export async function resolveClientDeviceName(
  userAgent: string,
  userAgentData?: HighEntropyUserAgent | null,
): Promise<string> {
  if (userAgentData && /Android/i.test(userAgent)) {
    try {
      const hints = await userAgentData.getHighEntropyValues(["model"]);
      const model = usableModel(hints.model);
      if (model) return model;
    } catch {
      // Hints are optional and may be refused; the string parse still applies.
    }
  }
  return defaultClientDeviceName(userAgent);
}

/**
 * Names *this* browser for the device list on the computer it pairs with.
 *
 * This becomes the persistent identity descriptor, so it is the label the
 * owner reads months later when deciding whether a listed device is still
 * theirs. A computer browser must never be filed as a phone: the connection
 * code exists precisely so a camera-less computer can pair, and calling it
 * 「我的手机」 makes the list unreadable.
 */
export function defaultClientDeviceName(userAgent: string): string {
  // Apple never puts the model in the user agent — every iPhone from the 6 to
  // the newest Pro Max reports the same string, and Safari has no client
  // hints either. "iPhone" is genuinely the most that can be known here.
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) {
    return (
      androidModelFromUserAgent(userAgent) ??
      (/Mobile/i.test(userAgent) ? "Android 手机" : "Android 平板")
    );
  }

  // Order matters: Edge and Opera also claim Chrome, and Chrome also claims
  // Safari, so the most specific token has to win.
  const browser = /Edg\//i.test(userAgent)
    ? "Edge"
    : /OPR\//i.test(userAgent)
      ? "Opera"
      : /Firefox\//i.test(userAgent)
        ? "Firefox"
        : /Chrome\//i.test(userAgent)
          ? "Chrome"
          : /Safari\//i.test(userAgent)
            ? "Safari"
            : null;
  const platform = /Windows/i.test(userAgent)
    ? "Windows"
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? "Mac"
      : /CrOS/i.test(userAgent)
        ? "ChromeOS"
        : /Linux/i.test(userAgent)
          ? "Linux"
          : null;

  if (platform && browser) return `${platform} · ${browser}`;
  if (platform) return `${platform} 浏览器`;
  if (browser) return `${browser} 浏览器`;
  return "网页浏览器";
}

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
