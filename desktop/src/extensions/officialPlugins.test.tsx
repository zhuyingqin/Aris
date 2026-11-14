// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as transport from "../api/transport";
import { useStore } from "../store";
import OfficialPluginsSection from "./OfficialPluginsSection";
import { LEGACY_HIDE_MAIL_KEY, migrateMailVisibility, type OfficialPluginState } from "./officialPlugins";

vi.mock("../api/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/transport")>()),
  invoke: vi.fn(),
}));

const projectPath = "F:/project";
const states = (mail: boolean): OfficialPluginState[] => [
  { id: "literature", scope: "project", toggleable: false, enabled: true, global: null, project: null },
  { id: "latex", scope: "project", toggleable: false, enabled: true, global: null, project: null },
  { id: "figures", scope: "project", toggleable: false, enabled: true, global: null, project: null },
  { id: "mail", scope: "user", toggleable: true, enabled: mail, global: mail, project: null },
];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(transport.invoke).mockReset();
  useStore.setState({ officialPlugins: null, hideMail: true, tab: "chat", language: "cn" });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("migrateMailVisibility", () => {
  it("turns mail on once for a profile that chose to show it", async () => {
    localStorage.setItem(LEGACY_HIDE_MAIL_KEY, "false");
    vi.mocked(transport.invoke).mockResolvedValue(states(true));
    const next = await migrateMailVisibility(projectPath, states(false));
    expect(transport.invoke).toHaveBeenCalledWith("official_plugins_set", { projectPath, id: "mail", target: "global", value: true });
    expect(next.find((state) => state.id === "mail")?.enabled).toBe(true);

    vi.mocked(transport.invoke).mockClear();
    await migrateMailVisibility(projectPath, states(false));
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("leaves the seeded value alone when mail was hidden or never chosen", async () => {
    localStorage.setItem(LEGACY_HIDE_MAIL_KEY, "true");
    expect(await migrateMailVisibility(projectPath, states(true))).toEqual(states(true));
    localStorage.clear();
    expect(await migrateMailVisibility(projectPath, states(false))).toEqual(states(false));
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});

describe("store mirror of the Mail plugin", () => {
  it("hides mail and leaves its tab when the backend says it is off", () => {
    useStore.setState({ hideMail: false, tab: "mail" });
    useStore.getState().applyOfficialPlugins(states(false));
    expect(useStore.getState().hideMail).toBe(true);
    expect(useStore.getState().tab).toBe("chat");
    expect(localStorage.getItem(LEGACY_HIDE_MAIL_KEY)).toBe("true");
  });

  it("writes the switch to the backend in the desktop app", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useStore.setState({
      currentProject: { id: "p", name: "Project", path: projectPath } as never,
      officialPlugins: states(true),
      hideMail: false,
    });
    vi.mocked(transport.invoke).mockResolvedValue(states(false));
    await useStore.getState().setHideMail(true);
    expect(transport.invoke).toHaveBeenCalledWith("official_plugins_set", { projectPath, id: "mail", target: "global", value: false });
    expect(useStore.getState().hideMail).toBe(true);
  });
});

describe("OfficialPluginsSection", () => {
  it("lists every official plugin and only lets mail be switched", async () => {
    const setHideMail = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ officialPlugins: states(true), setHideMail });
    render(<OfficialPluginsSection language="cn" />);
    for (const name of ["文献库", "LaTeX", "Figures", "邮箱"]) expect(screen.getByRole("article", { name })).toBeTruthy();
    const switches = screen.getAllByRole("switch");
    expect(switches.filter((item) => !(item as HTMLButtonElement).disabled)).toHaveLength(1);
    fireEvent.click(screen.getByRole("switch", { name: "关闭 邮箱" }));
    await waitFor(() => expect(setHideMail).toHaveBeenCalledWith(true));
  });
});
