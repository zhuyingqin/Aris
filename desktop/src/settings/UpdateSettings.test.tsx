// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall } from "../api/tauri";
import type { AppUpdateInfo, AppUpdateInstallResult } from "../types";
import UpdateSettings from "./UpdateSettings";
import OracleWebSettings from "./OracleWebSettings";

vi.mock("../api/tauri", () => ({ appUpdateCheck: vi.fn(), appUpdateDownloadAndInstall: vi.fn(), appRelaunch: vi.fn() }));
vi.mock("./OracleWebSettings", () => ({ default: vi.fn(() => <div>Oracle Web</div>) }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(appUpdateCheck).mockResolvedValue({ available: false });
  vi.mocked(appUpdateDownloadAndInstall).mockResolvedValue({ installed: true, version: "0.4.77" });
  vi.mocked(appRelaunch).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("UpdateSettings", () => {
  it("shows only application updates without mounting the plugin runtime or automatically checking", () => {
    render(<UpdateSettings language="en" appVersion="0.4.76" />);
    expect(screen.getByText("Current version v0.4.76")).toBeTruthy();
    expect(OracleWebSettings).not.toHaveBeenCalled();
    expect(appUpdateCheck).not.toHaveBeenCalled();
    expect(appUpdateDownloadAndInstall).not.toHaveBeenCalled();
  });

  it("checks the configured channel and reports the current version", async () => {
    render(<UpdateSettings language="cn" appVersion="0.4.76" />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("当前已是最新版本")).toBeTruthy();
    expect(appUpdateCheck).toHaveBeenCalledWith(true);
    expect(appUpdateDownloadAndInstall).not.toHaveBeenCalled();
  });

  it("disables repeated checks while the request is pending", async () => {
    let resolveCheck: ((info: AppUpdateInfo) => void) | undefined;
    vi.mocked(appUpdateCheck).mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve; }));
    render(<UpdateSettings language="en" appVersion="0.4.76" />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect((screen.getByRole("button", { name: "Checking..." }) as HTMLButtonElement).disabled).toBe(true);
    resolveCheck?.({ available: false });
    expect(await screen.findByText("You are on the latest version")).toBeTruthy();
  });

  it("shows release notes, download progress and a restart action after installing", async () => {
    vi.mocked(appUpdateCheck).mockResolvedValue({ available: true, version: "0.4.77", body: "Improved Oracle updates." });
    let resolveInstall: ((info: AppUpdateInstallResult) => void) | undefined;
    vi.mocked(appUpdateDownloadAndInstall).mockImplementationOnce(async (_, onProgress) => {
      onProgress?.({ stage: "progress", downloadedBytes: 1024, contentLength: 2048, percent: 50 });
      return new Promise(resolve => { resolveInstall = resolve; });
    });
    render(<UpdateSettings language="en" appVersion="0.4.76" />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Improved Oracle updates.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect(await screen.findByText(/50%/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Installing update" })).toHaveProperty("value", 50);
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
    resolveInstall?.({ installed: true, version: "0.4.77" });
    fireEvent.click(await screen.findByRole("button", { name: "Restart app" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    await waitFor(() => expect(appRelaunch).toHaveBeenCalledTimes(1));
  });

  it("reports a failed check and allows retry", async () => {
    vi.mocked(appUpdateCheck).mockRejectedValueOnce(new Error("Update service unavailable"));
    render(<UpdateSettings language="en" appVersion="0.4.76" />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Update service unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You are on the latest version")).toBeTruthy();
  });
});
