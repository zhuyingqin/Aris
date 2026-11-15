// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OfficialPluginState } from "../extensions/officialPlugins";
import { useStore } from "../store";
import Settings from "./Settings";

const literature = (enabled: boolean): OfficialPluginState => ({
  id: "literature", scope: "project", toggleable: true, enabled,
  global: null, globalEnabled: true, project: enabled ? null : false, workspaceOff: false,
});

// The Literature page's own "Settings" button asks for this page, so it must
// exist while the plugin is on and disappear with it.
describe("Literature settings page", () => {
  beforeEach(() => {
    sessionStorage.setItem("somniq-settings-tab-request", "literature");
    useStore.setState({ language: "en" });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    useStore.setState({ officialPlugins: null });
  });

  it("opens attachment naming when the library asks for it", () => {
    useStore.setState({ officialPlugins: [literature(true)] });
    const { container } = render(<Settings />);
    expect(screen.getByRole("tab", { name: "Literature" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-settings-page="literature"]')).toBeTruthy();
    expect(screen.getByText("Attachment naming")).toBeTruthy();
  });

  it("goes away with the Literature plugin", () => {
    useStore.setState({ officialPlugins: [literature(false)] });
    const { container } = render(<Settings />);
    expect(screen.queryByRole("tab", { name: "Literature" })).toBeNull();
    expect(container.querySelector('[data-settings-page="literature"]')).toBeNull();
  });
});
