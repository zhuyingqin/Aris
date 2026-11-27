// @vitest-environment jsdom
// Leaving a plugin page for another module must go straight there: the Plugins
// module (which shares the plugin page's place) must not show in between.
import { useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveUiPanel } from "../api/plugins";
import { useStore } from "../store";
import App from "../App";

const seen = vi.hoisted(() => ({ extensions: 0 }));
const board = vi.hoisted((): ActiveUiPanel => ({
  pluginName: "@local/farm", packageDigest: "d1", id: "console", slot: "nav.page", order: 0, scope: "project", title: "Farm console", widgets: [],
}));

vi.mock("../useAccountRefresh", () => ({
  useAccountRefresh: () => ({ account: null, refreshing: false, error: null, refresh: async () => {} }),
}));
vi.mock("../api/tauri", async (original) => ({ ...await original<typeof import("../api/tauri")>(), isTauri: () => false }));
vi.mock("../chat/Chat", () => ({ default: () => <section>Chat workspace</section> }));
vi.mock("../settings/Settings", () => ({ default: () => <section>Settings workspace</section> }));
// Counts every time the Plugins module mounts.
vi.mock("../extensions/Extensions", () => ({
  default: () => {
    useEffect(() => { seen.extensions += 1; }, []);
    return <section>Plugins module</section>;
  },
}));
vi.mock("../extensions/PluginPage", () => ({ default: ({ panel }: { panel: ActiveUiPanel }) => <section>Plugin page {panel.id}</section> }));
vi.mock("../extensions/useChatPluginPanels", async (original) => {
  const actual = await original<typeof import("../extensions/useChatPluginPanels")>();
  return {
    ...actual,
    useChatPluginPanels: (_project: string | undefined, slot: string) => {
      const panels = slot === "nav.page" ? [board] : [];
      return { panels, all: panels, error: "", loaded: true, refresh: async () => {} };
    },
  };
});
vi.mock("../OnboardingTutorial", () => ({ default: () => null }));
vi.mock("../code/CodePane", () => ({ default: () => null }));
vi.mock("../literature/Literature", () => ({ default: () => <section>Literature workspace</section> }));
vi.mock("../mail/Mail", () => ({ default: () => null }));
vi.mock("../typeset/Typeset", () => ({ default: () => null }));
vi.mock("../workflows/Workflows", () => ({ default: () => null }));

const originalState = useStore.getState();
const project = { id: "p1", name: "Farm", path: "F:/farm", addedAt: 0, lastOpenedAt: 0 };
beforeEach(() => {
  seen.extensions = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  useStore.setState({ ...originalState, tab: "chat", language: "en", projects: [project], currentProject: project, init: () => () => {}, error: null });
});
afterEach(() => { cleanup(); sessionStorage.clear(); useStore.setState(originalState, true); vi.unstubAllGlobals(); });

describe("leaving a plugin page", () => {
  it("goes straight to Chat without showing the Plugins module on the way", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Farm console" }));
    expect(await screen.findByText("Plugin page console")).toBeTruthy();
    expect(seen.extensions).toBe(0);

    await user.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => expect(screen.queryByText("Plugin page console")).toBeNull());
    expect(seen.extensions).toBe(0);
    expect(screen.queryByText("Plugins module")).toBeNull();
  });

  it("still opens the Plugins module itself when the user asks for it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Farm console" }));
    expect(await screen.findByText("Plugin page console")).toBeTruthy();
    // From a plugin page, the Plugins module is a different page in the same place.
    await user.click(screen.getByRole("button", { name: /^(Plugins|Extensions)$/ }));
    expect(await screen.findByText("Plugins module")).toBeTruthy();
    expect(screen.queryByText("Plugin page console")).toBeNull();
  });
});
