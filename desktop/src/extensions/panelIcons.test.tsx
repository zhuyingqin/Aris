// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_ICON_PATH_CHARS, PANEL_ICONS, panelIconPath } from "./panelIcons";
import PluginPanelIcon from "./PluginPanelIcon";

const uiRs = readFileSync(resolve(process.cwd(), "../crates/runtime/src/plugins/ui.rs"), "utf8");

describe("plugin panel icons", () => {
  it("lists exactly the backend's UI_ICONS, in order", () => {
    const block = uiRs.match(/const UI_ICONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? "";
    expect([...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])).toEqual([...PANEL_ICONS]);
    expect(uiRs).toContain(`MAX_UI_ICON_PATH_CHARS: usize = ${MAX_ICON_PATH_CHARS};`);
  });

  it("draws every listed name as a host icon", () => {
    for (const icon of PANEL_ICONS) {
      const { container, unmount } = render(<PluginPanelIcon panel={{ icon, widgets: [] }} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("data-icon")).toBe(icon);
      expect(svg?.childElementCount).toBeGreaterThan(0);
      unmount();
    }
  });

  it("strokes a panel's own outline and refuses anything that is not path data", () => {
    const { container } = render(<PluginPanelIcon panel={{ iconPath: "M8 14V7.5M4.5 14h7", icon: "grid", widgets: [] }} />);
    expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe("plugin-path");
    expect(container.querySelector("path")?.getAttribute("d")).toBe("M8 14V7.5M4.5 14h7");
    for (const bad of ["<svg/>", "M0 0\"/><script>", "url(#a)", "L1 1", "M", `M${"1 ".repeat(600)}`]) {
      expect(panelIconPath(bad)).toBeUndefined();
    }
    const fallback = render(<PluginPanelIcon panel={{ iconPath: "url(#x)", widgets: [{ id: "n", type: "notes", title: "N" }] }} />);
    expect(fallback.container.querySelector("svg")?.getAttribute("data-icon")).toBe("notebook");
  });
});
