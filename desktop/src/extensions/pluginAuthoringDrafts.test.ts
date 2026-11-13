import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../api/plugins";
import { pluginCreationDraft, pluginNeedsRepair, pluginRepairDraft } from "./pluginAuthoringDrafts";

const plugin = (extra: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  name: "@local/tools",
  version: "0.2.0",
  description: "",
  source: "F:\\work\\.somniq\\plugin-drafts\\tools",
  digest: "sha256:a",
  canEnable: false,
  diagnostics: [
    { code: "capability", message: "transport http is not supported", severity: "error", file: "cordis.patch.yml", path: "mcp" },
    { code: "approval-required", message: "needs approval", severity: "warning" },
  ],
  capabilities: { skills: [], skillRoots: [], mcpServers: [], uiPanels: [] },
  enabled: false,
  status: "blocked",
  lifecycle: { state: "blocked", activeRuns: 0, staleRuns: 0, mcpServers: [] },
  ...extra,
});

describe("plugin authoring drafts", () => {
  it("names the plugin skill in the creation draft", () => {
    expect(pluginCreationDraft("cn")).toContain("somniq-plugin-development");
    expect(pluginCreationDraft("en")).toContain("somniq-plugin-development");
  });

  it("offers a repair only for a package that cannot run or whose MCP failed", () => {
    expect(pluginNeedsRepair(plugin())).toBe(true);
    const healthy = plugin({ canEnable: true, status: "enabled", enabled: true, diagnostics: [],
      lifecycle: { state: "enabled", activeRuns: 0, staleRuns: 0, mcpServers: [] } });
    expect(pluginNeedsRepair(healthy)).toBe(false);
    expect(pluginNeedsRepair({ ...healthy, lifecycle: { ...healthy.lifecycle, state: "failed" } })).toBe(true);
  });

  it("carries the source, diagnostics and failed servers, without the approval notice", () => {
    const failed = plugin({
      lifecycle: {
        state: "failed", activeRuns: 0, staleRuns: 0,
        mcpServers: [{ name: "dates", runtimeName: "p1_dates", health: "failed", toolCount: 0, message: "spawn python ENOENT", checkedAtMs: 1 }],
      },
    });
    const draft = pluginRepairDraft(failed, "F:/work", "en");
    expect(draft).toContain("@local/tools (v0.2.0)");
    expect(draft).toContain("F:\\work\\.somniq\\plugin-drafts\\tools");
    expect(draft).toContain("[capability] transport http is not supported (cordis.patch.yml mcp)");
    expect(draft).toContain("MCP dates: spawn python ENOENT");
    expect(draft).not.toContain("approval-required");
    expect(draft).toContain("upgrade");
    expect(draft).not.toContain("outside this project");
  });

  it("asks to copy a package that lives outside the project first", () => {
    const outside = plugin({ source: "D:/downloads/tools" });
    expect(pluginRepairDraft(outside, "F:/work", "cn")).toContain("不在当前项目里");
    expect(pluginRepairDraft(outside, "F:/work", "en")).toContain("outside this project");
    // A sibling whose name only starts with the project's is still outside.
    expect(pluginRepairDraft(plugin({ source: "F:/work-other/tools" }), "F:/work", "en")).toContain("outside this project");
  });
});
