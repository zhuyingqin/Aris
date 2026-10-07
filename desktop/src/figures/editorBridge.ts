/** Validate every message against its frame and per-mount channel. The bridge
 * accepts SVG strings only; it exposes no invoke, filesystem or auth function. */
export function editorMessage(event: MessageEvent, frame: Window | null, channel: string): Record<string, unknown> | null {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== "object" || event.data.channel !== channel) return null;
  const message = event.data as Record<string, unknown>;
  if (!["ready", "loaded", "dirty", "serialized", "error"].includes(String(message.type))) return null;
  if (message.type === "serialized" && (typeof message.svg !== "string" || message.svg.length > 2 * 1024 * 1024)) return null;
  return message;
}
