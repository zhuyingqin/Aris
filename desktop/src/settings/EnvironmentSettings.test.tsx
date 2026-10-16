// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { configSet, isTauri, localEnvironmentChecks } from "../api/tauri";
import { handoffEnvironmentInstall } from "../environmentInstall";
import type { ConfigView, LocalEnvironmentCheck } from "../types";
import EnvironmentSettings from "./EnvironmentSettings";

vi.mock("../api/tauri", () => ({ configSet: vi.fn(), isTauri: vi.fn(), localEnvironmentChecks: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../environmentInstall", async (importOriginal) => ({
  ...await importOriginal<typeof import("../environmentInstall")>(),
  handoffEnvironmentInstall: vi.fn(),
}));

const checks: LocalEnvironmentCheck[] = [
  { id: "python", label: "Python", category: "Runtime", status: "ready", available: true, version: "Python 3.12.8", path: "C:/Python/python.exe", message: "Ready" },
  { id: "jupyter", label: "Jupyter", category: "Notebook", status: "missing", available: false, message: "Missing" },
  { id: "latex", label: "LaTeX", category: "Typesetting", status: "missing", available: false, message: "Missing" },
  { id: "uv", label: "uv", category: "MCP / Python", status: "missing", available: false, message: "Missing" },
];

function renderEnvironment() {
  const onConfigRefreshed = vi.fn();
  const view = render(<EnvironmentSettings language="en" pythonEnvironmentPath="C:/Python" onConfigRefreshed={onConfigRefreshed} />);
  return { ...view, onConfigRefreshed };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(localEnvironmentChecks).mockResolvedValue(checks);
  vi.mocked(configSet).mockImplementation(async patch => ({ pythonEnvironmentPath: patch.pythonEnvironmentPath } as ConfigView));
  vi.mocked(openDialog).mockResolvedValue(null);
});
afterEach(cleanup);

describe("EnvironmentSettings", () => {
  it("hides Apply for an unchanged environment, including whitespace-only edits", async () => {
    renderEnvironment();
    await screen.findByText("Python 3.12.8");
    expect(screen.queryByRole("button", { name: "Use environment" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "Preferred Python / Conda environment" });
    fireEvent.change(input, { target: { value: "  C:/Python  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Use environment" })).toBeNull();
    expect(configSet).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy();
  });

  it("applies the edited path once with Enter, then hides Apply and refreshes diagnostics", async () => {
    const { onConfigRefreshed } = renderEnvironment();
    await screen.findByText("Python 3.12.8");
    let finish!: (view: ConfigView) => void;
    vi.mocked(configSet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = screen.getByRole("textbox", { name: "Preferred Python / Conda environment" });
    fireEvent.change(input, { target: { value: "  C:/Research-env  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Applying..." })).toHaveProperty("disabled", true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({ pythonEnvironmentPath: "C:/Research-env" });

    const next = { pythonEnvironmentPath: "C:/Research-env" } as ConfigView;
    finish(next);
    await screen.findByText("Applied");
    expect(onConfigRefreshed).toHaveBeenCalledWith(next);
    expect(localEnvironmentChecks).toHaveBeenLastCalledWith(true);
    expect(input).toHaveProperty("value", "C:/Research-env");
    expect(input).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Use environment" })).toBeNull();
  });

  it("retains an edited path and the Apply action after a failed save", async () => {
    renderEnvironment();
    await screen.findByText("Python 3.12.8");
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    const input = screen.getByRole("textbox", { name: "Preferred Python / Conda environment" });
    fireEvent.change(input, { target: { value: "C:/Research-env" } });
    fireEvent.click(screen.getByRole("button", { name: "Use environment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Disk is read-only");
    expect(input).toHaveProperty("value", "C:/Research-env");
    expect(screen.getByRole("button", { name: "Use environment" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Use environment" }));
    await screen.findByText("Applied");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(configSet).toHaveBeenCalledTimes(2);
  });

  it("keeps directory selection as a draft until applied and preserves it when selection is cancelled", async () => {
    renderEnvironment();
    await screen.findByText("Python 3.12.8");
    vi.mocked(openDialog).mockResolvedValueOnce("C:/Conda/research");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveProperty("value", "C:/Conda/research"));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
    expect(configSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "C:/Conda/research");
    expect(screen.getByRole("button", { name: "Use environment" })).toBeTruthy();
  });

  it("prevents overlapping refreshes, reports failure, and clears it on retry", async () => {
    renderEnvironment();
    await screen.findByText("Python 3.12.8");
    let fail!: (error: Error) => void;
    vi.mocked(localEnvironmentChecks).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const checking = screen.getByRole("button", { name: "Checking..." });
    expect(checking).toHaveProperty("disabled", true);
    expect(screen.getByText("Python 3.12.8")).toBeTruthy();
    fireEvent.click(checking);
    expect(localEnvironmentChecks).toHaveBeenCalledTimes(2);
    fail(new Error("Probe failed"));
    expect((await screen.findByRole("alert")).textContent).toContain("Probe failed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(localEnvironmentChecks).toHaveBeenCalledTimes(3);
    expect(localEnvironmentChecks).toHaveBeenLastCalledWith(true);
  });

  it("offers missing installable environments from one disclosure without repeating card buttons", async () => {
    const { container } = renderEnvironment();
    await screen.findByText("Python 3.12.8");
    expect(container.querySelectorAll(".sp-env-card button")).toHaveLength(0);
    const install = screen.getByText("Install with Chat");
    const disclosure = install.closest("details");
    expect(disclosure).toHaveProperty("open", false);
    fireEvent.click(install);
    expect(disclosure).toHaveProperty("open", true);
    expect(screen.getByRole("button", { name: "Jupyter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "LaTeX" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "uv" })).toBeNull();
    fireEvent.keyDown(install, { key: "Escape" });
    expect(disclosure).toHaveProperty("open", false);
    fireEvent.click(install);
    fireEvent.click(screen.getByRole("button", { name: "LaTeX" }));
    expect(handoffEnvironmentInstall).toHaveBeenCalledWith("latex", "en");
  });
});
