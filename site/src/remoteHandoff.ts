/**
 * How the console reaches the remote workspace (`site/remote/`).
 *
 * The console can either frame the workspace in an iframe or hand the whole
 * screen over to it. Which one applies is a viewport decision, and the URL
 * differs in one load-bearing way — see `embedded` below.
 */

/**
 * When the console shell (topbar, nav, stage toolbar) costs more room than the
 * workspace it frames, the console hands off instead of embedding.
 *
 * The width clause matches the console's own narrow breakpoint in
 * `styles.css`. The height clause catches a phone held sideways, which is
 * wider than that breakpoint but has even less room to spare; `pointer:
 * coarse` keeps it from hijacking a short desktop window, where being
 * navigated away from the console would just be startling.
 */
export const FULL_SCREEN_REMOTE_QUERY =
  "(max-width: 720px), (max-height: 560px) and (pointer: coarse)";

export interface RemoteWorkspaceUrlOptions {
  /** The paired client to dial, when one is already known. */
  deviceId: string | null;
  theme: string;
  /**
   * `embed=1` puts the workspace in its desktop layout and tells it that it is
   * not the top-level document. Never set it for a handoff: a phone would get
   * the desktop layout in a phone-sized frame, and the app's software-keyboard
   * compensation reads `window.visualViewport`, which in a subframe never
   * reports the keyboard — the composer ends up underneath it.
   */
  embedded: boolean;
  /** Dev-only design preview: the app fakes a conversation instead of dialing. */
  preview?: boolean;
}

export function buildRemoteWorkspaceUrl(options: RemoteWorkspaceUrlOptions): string {
  const params = new URLSearchParams();
  if (options.embedded) params.set("embed", "1");
  params.set("theme", options.theme);
  if (options.preview) {
    params.set("preview", "chat");
  } else if (options.deviceId) {
    params.set("desktop", options.deviceId);
  }
  return `./remote/?${params.toString()}`;
}
