// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageAssistPublish, oracleWebRuntimeInstall, oracleWebStatus } from "../api/tauri";
import type { OracleWebStatusView } from "../types";
import { ImageAssistReadiness } from "./ImageAssistReadiness";

vi.mock("../api/tauri", () => ({
  imageAssistPublish: vi.fn(), oracleWebRuntimeInstall: vi.fn(), oracleWebStatus: vi.fn(),
}));

const status = (runtimeStatus = "ready", bound = true): OracleWebStatusView => ({
  runtime: { status: runtimeStatus, source: "managed", version: runtimeStatus === "ready" ? "0.21.4" : "0.18.0",
    installSupported: true, message: "runtime status" },
  accounts: [{ id: "image-account", displayName: "Image account", browserName: "Edge", browserKind: "edge",
    browserPath: "C:/Edge.exe", profilePath: "C:/profile", createdAt: 1 }],
  imageAccountId: bound ? "image-account" : null, browsers: [], dataDir: "C:/SomniQ",
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(oracleWebStatus).mockResolvedValue(status());
  vi.mocked(oracleWebRuntimeInstall).mockResolvedValue(status());
  vi.mocked(imageAssistPublish).mockResolvedValue(true);
});
afterEach(cleanup);

describe("ImageAssistReadiness", () => {
  it("explains why an opted-in helper with an old runtime is absent from the roster", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(status("incompatible"));
    render(<ImageAssistReadiness enabled language="cn" />);
    expect(await screen.findByText(/网页出图组件需要更新/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新出图组件" })).toBeTruthy();
  });

  it("republishes existing consent and location after a successful update", async () => {
    const location = { label: "Mexico City", latitude: 19.4, longitude: -99.1 };
    window.localStorage.setItem("somniq.image-assist.approximate-location.v1", JSON.stringify(location));
    vi.mocked(oracleWebStatus).mockResolvedValue(status("incompatible"));
    render(<ImageAssistReadiness enabled language="cn" />);
    fireEvent.click(await screen.findByRole("button", { name: "更新出图组件" }));
    await waitFor(() => expect(imageAssistPublish).toHaveBeenCalledWith(undefined, location));
    expect(oracleWebRuntimeInstall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps an installation failure visible and does not advertise readiness", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(status("incompatible"));
    vi.mocked(oracleWebRuntimeInstall).mockRejectedValue(new Error("download failed"));
    render(<ImageAssistReadiness enabled language="cn" />);
    fireEvent.click(await screen.findByRole("button", { name: "更新出图组件" }));
    expect(await screen.findByText(/download failed/)).toBeTruthy();
    expect(imageAssistPublish).not.toHaveBeenCalled();
  });

  it("explains the missing image-account binding after installing the runtime", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(status("missing", false));
    vi.mocked(oracleWebRuntimeInstall).mockResolvedValue(status("ready", false));
    render(<ImageAssistReadiness enabled language="cn" />);
    fireEvent.click(await screen.findByRole("button", { name: "安装出图组件" }));
    expect(await screen.findByText(/尚未绑定出图账号/)).toBeTruthy();
    expect(imageAssistPublish).not.toHaveBeenCalled();
  });

  it("does not check or install anything while helping is disabled", () => {
    render(<ImageAssistReadiness enabled={false} language="cn" />);
    expect(oracleWebStatus).not.toHaveBeenCalled();
    expect(oracleWebRuntimeInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
