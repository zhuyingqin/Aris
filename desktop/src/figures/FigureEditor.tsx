import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { editorMessage } from "./editorBridge";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "../api/tauri";

export interface FigureEditorHandle { serialize: () => Promise<string> }
const FigureEditor = forwardRef<FigureEditorHandle, { svg: string; onDirty: () => void; onError: (error: string) => void }>(function FigureEditor({ svg, onDirty, onError }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef(crypto.randomUUID());
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onDirty, onError }); callbacks.current = { onDirty, onError };
  const pending = useRef(new Map<string, { resolve: (svg: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = editorMessage(event, frame.current?.contentWindow ?? null, channel.current);
      if (!message) return;
      if (message.type === "ready") setReady(true);
      if (message.type === "loaded") setLoaded(true);
      if (message.type === "dirty") callbacks.current.onDirty();
      if (message.type === "error") callbacks.current.onError(String(message.message ?? "Editor error"));
      if (message.type === "serialized" || message.type === "error") {
        const task = pending.current.get(String(message.requestId));
        if (task) {
          clearTimeout(task.timer); pending.current.delete(String(message.requestId));
          if (message.type === "serialized") task.resolve(String(message.svg));
          else task.reject(new Error(String(message.message)));
        }
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const task of pending.current.values()) { clearTimeout(task.timer); task.reject(new Error("Editor closed")); }
      pending.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    setLoaded(false);
    frame.current?.contentWindow?.postMessage({ channel: channel.current, type: "load", requestId: crypto.randomUUID(), svg }, "*");
  }, [ready, svg]);
  useImperativeHandle(ref, () => ({
    serialize: () => new Promise<string>((resolve, reject) => {
      if (!loaded) { reject(new Error("Editor is still loading")); return; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.current.delete(requestId); reject(new Error("Editor did not respond")); }, 10_000);
      pending.current.set(requestId, { resolve, reject, timer });
      frame.current?.contentWindow?.postMessage({ channel: channel.current, type: "serialize", requestId }, "*");
    }),
  }), [loaded]);
  const location = isTauri() ? `${convertFileSrc("", "somniq-figure")}figure-editor/index.html` : "./figure-editor/index.html";
  return <iframe ref={frame} className="figure-editor" title="SVG-Edit" src={`${location}#${channel.current}`} sandbox="allow-scripts" />;
});
export default FigureEditor;
