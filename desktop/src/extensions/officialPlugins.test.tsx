// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as transport from "../api/transport";
import { useStore } from "../store";
import OfficialPluginsSection from "./OfficialPluginsSection";
import { OFFICIAL_PLUGIN_NAV_ITEMS } from "./officialPluginNav";
import { workspaceFileOpenTarget } from "../editor/workspaceFiles";
import {
  LEGACY_HIDE_MAIL_KEY, OFFICIAL_PLUGIN_TABS, latexWorkspaceOn, migrateMailVisibility, officialTabHidden, switchTarget,
  type OfficialPluginState,
} from "./officialPlugins";

vi.mock("../api/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/transport")>()),
  invoke: vi.fn(),
}));

const projectPath = "F:/project";
const states = (mail: boolean): OfficialPluginState[] => [
  { id: "literature", scope: "project", toggleable: false, enabled: true, global: null, globalEnabled: true, project: null, workspaceOff: false },
  { id: "latex", scope: "project", toggleable: false, enabled: true, global: null, globalEnabled: true, project: null, workspaceOff: false },
  { id: "figures", scope: "project", toggleable: false, enabled: true, global: null, globalEnabled: true, project: null, workspaceOff: false },
  { id: "mail", scope: "user", toggleable: true, enabled: mail, global: mail, globalEnabled: mail, project: null, workspaceOff: false },
];

const realSetHideMail = useStore.getState().setHideMail;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(transport.invoke).mockReset();
  useStore.setState({ officialPlugins: null, hideMail: true, tab: "chat", language: "cn", setHideMail: realSetHideMail });
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

describe("per-project switches", () => {
  const mailWith = (extra: Partial<OfficialPluginState>) =>
    states(false).map((state) => state.id === "mail" ? { ...state, ...extra } : state);

  it("writes where a click takes effect", () => {
    const mail = (extra: Partial<OfficialPluginState>) => mailWith(extra).find((state) => state.id === "mail")!;
    expect(switchTarget(mail({}))).toBe("global");
    expect(switchTarget(mail({ project: false }))).toBe("project");
    // The project asks for it off: a global "on" would be outranked.
    expect(switchTarget(mail({ workspaceOff: true }))).toBe("project");
    // Project-scoped plugins never flip every project at once.
    const figures = states(true).find((state) => state.id === "figures")!;
    expect(switchTarget(figures)).toBe("project");
  });

  it("turns mail on for this project when the project asked for it off", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useStore.setState({
      currentProject: { id: "p", name: "Project", path: projectPath } as never,
      officialPlugins: mailWith({ workspaceOff: true }),
      hideMail: true,
    });
    vi.mocked(transport.invoke).mockResolvedValue(mailWith({ enabled: true, project: true, workspaceOff: true }));
    await useStore.getState().setHideMail(false);
    expect(transport.invoke).toHaveBeenCalledWith("official_plugins_set", { projectPath, id: "mail", target: "project", value: true });
    expect(useStore.getState().hideMail).toBe(false);
  });

  it("offers follow / on / off for this project and explains a project request", async () => {
    useStore.setState({
      currentProject: { id: "p", name: "Project", path: projectPath } as never,
      officialPlugins: mailWith({ workspaceOff: true, global: true, globalEnabled: true }),
    });
    vi.mocked(transport.invoke).mockResolvedValue(mailWith({ project: false }));
    render(<OfficialPluginsSection language="cn" />);
    expect(screen.getByText(/official\.json 要求关闭/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "off" } });
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledWith(
      "official_plugins_set", { projectPath, id: "mail", target: "project", value: false }));
  });
});

describe("official plugin navigation", () => {
  it("each nav entry is the page its plugin owns, and hides with it", () => {
    for (const item of OFFICIAL_PLUGIN_NAV_ITEMS) expect(item.id).toBe(OFFICIAL_PLUGIN_TABS[item.plugin]);
    const figuresOff = states(true).map((state) => state.id === "figures" ? { ...state, enabled: false } : state);
    expect(officialTabHidden("figures", figuresOff, false)).toBe(true);
    expect(officialTabHidden("figures", null, false)).toBe(false);
    expect(officialTabHidden("lab", figuresOff, true)).toBe(false);
    expect(officialTabHidden("mail", states(true), true)).toBe(true);
  });
});

describe("the LaTeX plugin", () => {
  it("hides the LaTeX page and opens .tex in Code while it is off", () => {
    const latexOff = states(true).map((state) => state.id === "latex" ? { ...state, toggleable: true, enabled: false } : state);
    expect(officialTabHidden("typeset", latexOff, false)).toBe(true);
    expect(latexWorkspaceOn(latexOff)).toBe(false);
    expect(latexWorkspaceOn(null)).toBe(true);
    expect(workspaceFileOpenTarget("paper/main.tex")).toBe("latex");
    expect(workspaceFileOpenTarget("paper/main.tex", { latexWorkspace: false })).toBe("code");
    expect(workspaceFileOpenTarget("figs/plot.pdf", { latexWorkspace: false })).toBe("pdf");
  });
});
