// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SomniImageSettings from "./SomniImageSettings";

const api = vi.hoisted(() => ({ isTauri: vi.fn(), somniImageSettings: vi.fn(), somniImageSettingsSet: vi.fn() }));
vi.mock("../api/tauri", () => api);
const initial = { enabled: true, model: "gpt-image-2", models: ["gpt-image-2", "gpt-image-2.5-flare"], available: true };
beforeEach(() => {
  vi.resetAllMocks();
  api.isTauri.mockReturnValue(true);
  api.somniImageSettings.mockResolvedValue(initial);
  api.somniImageSettingsSet.mockImplementation(async (enabled, model) => ({ ...initial, enabled, model, available: enabled }));
});
afterEach(cleanup);

describe("SomniImageSettings", () => {
  it("shows drawing models and the agent prompt workflow without credential fields", async () => {
    render(<SomniImageSettings language="en" models={["gpt-6.1-sol", ...initial.models]} />);
    const select = await screen.findByRole("combobox", { name: "Drawing model" });
    expect((select as HTMLSelectElement).value).toBe("gpt-image-2");
    expect(screen.queryByRole("option", { name: "gpt-6.1-sol" })).toBeNull();
    expect(screen.getByText(/chat model turns your request into a complete prompt/i)).toBeTruthy();
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
  });

  it("persists drawing model choice and disables generation independently", async () => {
    const user = userEvent.setup();
    render(<SomniImageSettings language="en" models={initial.models} />);
    await user.selectOptions(await screen.findByRole("combobox"), "gpt-image-2.5-flare");
    await waitFor(() => expect(api.somniImageSettingsSet).toHaveBeenCalledWith(true, "gpt-image-2.5-flare"));
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.somniImageSettingsSet).toHaveBeenLastCalledWith(false, "gpt-image-2.5-flare"));
  });

  it("keeps the saved model when persistence fails", async () => {
    api.somniImageSettingsSet.mockRejectedValue(new Error("Quota service unavailable"));
    render(<SomniImageSettings language="en" models={initial.models} />);
    await userEvent.selectOptions(await screen.findByRole("combobox"), "gpt-image-2.5-flare");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("gpt-image-2");
  });

  it("reloads drawing availability after the gateway models are synced", async () => {
    api.somniImageSettings.mockResolvedValueOnce({ enabled: true, model: null, models: [], available: false });
    const { rerender } = render(<SomniImageSettings language="en" models={[]} />);
    expect(await screen.findByText(/Sign in and sync models above/)).toBeTruthy();
    rerender(<SomniImageSettings language="en" models={initial.models} />);
    await screen.findByRole("combobox");
    expect(api.somniImageSettings).toHaveBeenCalledTimes(2);
  });

  it("does not invoke backend commands in browser preview", async () => {
    api.isTauri.mockReturnValue(false);
    render(<SomniImageSettings language="en" models={initial.models} />);
    expect(await screen.findByText("Browser preview does not call the drawing service.")).toBeTruthy();
    expect(api.somniImageSettings).not.toHaveBeenCalled();
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
  });
});
