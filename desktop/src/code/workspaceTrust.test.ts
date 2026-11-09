// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForWorkspaceTrust, validTrustModel, workbenchFrameUrl } from "./workspaceTrust";

const channel = "somniq-workspace-trust/v1";
const model = JSON.stringify({ uriTrustInfo: [{ uri: { scheme: "file", path: "/e:/科研论文/持续学习" }, trusted: true }] });
const key = "somniq-code-workspace-trust-v1";
beforeEach(() => localStorage.clear());
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function frameAt(port: number) {
  const frame = document.createElement("iframe");
  const url = `http://code.tauri.localhost:${port}/?tkn=fixture&folder=%2Fe%3A%2Fwork`;
  document.body.append(frame);
  const reply = vi.spyOn(frame.contentWindow!, "postMessage");
  const stop = listenForWorkspaceTrust(frame, url);
  const send = (data: object, source: Window | null = frame.contentWindow, origin = new URL(url).origin) => {
    window.dispatchEvent(new MessageEvent("message", { source, origin, data: { channel, id: "request-1", ...data } }));
  };
  return { frame, reply, stop, send, origin: new URL(url).origin };
}

describe("workbench trust persistence", () => {
  it("restores the recorded choice after a reload and a server port change", () => {
    const first = frameAt(42411);
    first.send({ type: "save", model });
    expect(localStorage.getItem(key)).toBe(model);
    expect(first.reply).toHaveBeenLastCalledWith(expect.objectContaining({ saved: true }), first.origin);
    first.stop(); first.frame.remove();
    const second = frameAt(42415);
    second.send({ type: "load" });
    expect(second.reply).toHaveBeenLastCalledWith(expect.objectContaining({ model }), second.origin);
    second.stop();
  });

  it("starts without any trusted folder and persists revocation", () => {
    const current = frameAt(42411);
    current.send({ type: "load" });
    expect(current.reply).toHaveBeenLastCalledWith(expect.objectContaining({ model: null }), current.origin);
    current.send({ type: "save", model });
    const revoked = JSON.stringify({ uriTrustInfo: [] });
    current.send({ type: "save", model: revoked });
    current.send({ type: "load" });
    expect(current.reply).toHaveBeenLastCalledWith(expect.objectContaining({ model: revoked }), current.origin);
    current.stop();
  });

  it("rejects other windows, other origins, malformed messages and stale frames", () => {
    const current = frameAt(42411);
    current.send({ type: "save", model }, window);
    current.send({ type: "save", model }, current.frame.contentWindow, "https://example.com");
    current.send({ type: "save", model: '{"uriTrustInfo":[{"trusted":true}]}' });
    expect(localStorage.getItem(key)).toBeNull();
    expect(current.reply).not.toHaveBeenCalled();
    current.stop();
    current.send({ type: "save", model });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("reports a storage failure without acknowledging a durable choice", () => {
    const current = frameAt(42411);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    current.send({ type: "save", model });
    expect(current.reply).toHaveBeenLastCalledWith(expect.objectContaining({ saved: false }), current.origin);
    current.stop();
  });

  it("adds the parent origin without changing the token or folder", () => {
    const url = new URL(workbenchFrameUrl("http://code.tauri.localhost:42411/?tkn=fixture&folder=%2Fe%3A%2F%E7%A7%91%E7%A0%94"));
    expect(url.searchParams.get("folder")).toBe("/e:/科研");
    expect(url.searchParams.get("tkn")).toBe("fixture");
    expect(url.searchParams.get("somniqTrustHost")).toBe(window.location.origin);
  });

  it("does not accept an invented trust state or unbounded storage payload", () => {
    for (const value of [null, "bad json", '{"uriTrustInfo":[{"uri":{"scheme":"file","path":"/work"},"trusted":false}]}', " ".repeat(512 * 1024 + 1)]) {
      expect(validTrustModel(value)).toBe(false);
    }
    expect(validTrustModel(model)).toBe(true);
  });
});
