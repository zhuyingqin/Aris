import { describe, expect, it } from "vitest";

import { OFFICIAL_PLUGIN_NAV_ITEMS } from "./officialPluginNav";
import { OFFICIAL_PLUGIN_PAGES, officialPluginPage } from "./officialPluginPages";
import { OFFICIAL_PLUGIN_TABS } from "./officialPlugins";

describe("official plugin pages", () => {
  it("each page belongs to its plugin's tab and nav entry", () => {
    for (const page of OFFICIAL_PLUGIN_PAGES) {
      expect(OFFICIAL_PLUGIN_TABS[page.plugin]).toBe(page.tab);
      expect(OFFICIAL_PLUGIN_NAV_ITEMS.some((item) => item.plugin === page.plugin && item.id === page.tab)).toBe(true);
    }
  });

  it("keeps Figures and LaTeX mounted, so drafts and jobs survive tab switches", () => {
    expect(officialPluginPage("figures")).toMatchObject({ mount: "keep", paneClassName: "app-figures-pane", navigationShell: true });
    expect(officialPluginPage("typeset")).toMatchObject({ mount: "keep", paneClassName: "app-typeset-pane" });
    expect(officialPluginPage("mail")?.mount).toBe("visible");
  });

  it("leaves Literature and core tabs to the shell", () => {
    expect(officialPluginPage("literature")).toBeNull();
    expect(officialPluginPage("chat")).toBeNull();
  });
});
