// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityEnforcement } from "../api/plugins";
import { CapabilityChanges, EnforcementLegend, ServerCapabilities, SkillScriptsNote } from "./PluginCapabilities";

const windows: CapabilityEnforcement = {
  environment: "enforced", hostControls: "enforced", workingDirectory: "enforced", processTree: "enforced",
  workspaceFiles: "enforced", networkNone: "declared", networkHosts: "declared", workspaceAccess: "declared",
};
afterEach(cleanup);

const row = (name: string) => (screen.getByText(name).closest(".plugin-capability-row") as HTMLElement).querySelector("dd") as HTMLElement;

describe("plugin capabilities", () => {
  it("shows each declared need with the level this computer enforces it at", () => {
    render(<ServerCapabilities language="en" enforcement={windows} capability={{
      env: ["CROSSREF_MAILTO"], network: { access: "required", hosts: ["api.crossref.org"] }, workspace: "read", workspaceFiles: ["scripts/normalize.py"],
    }} launch={[{ kind: "runtime-fetch", launcher: "npx", spec: "@scope/tool@1.2.3" }]} />);
    expect(row("Environment").textContent).toBe("Platform variables, plus CROSSREF_MAILTO from your computerEnforced");
    expect(row("Network").textContent).toBe("Needed: api.crossref.orgDeclared only");
    expect(row("Working directory").textContent).toContain("not the project");
    expect(row("Project").textContent).toBe("Reads itDeclared only");
    expect(row("Project files").textContent).toBe("Gets the copies of scripts/normalize.py you approveEnforced");
    expect(row("Processes").textContent).toBe("End when SomniQ quitsEnforced");
    expect(row("Downloads at start").textContent).toBe("npx downloads @scope/tool@1.2.3; the approval does not cover what it downloadsDeclared only");
  });

  it("says plainly when a server declared nothing, and when it needs nothing", () => {
    const { unmount } = render(<ServerCapabilities language="cn" enforcement={windows} capability={null} />);
    expect(screen.getByText("没有声明需要哪些能力，这个版本不能启用。")).toBeTruthy();
    unmount();
    render(<ServerCapabilities language="cn" enforcement={windows} capability={{ network: { access: "none" }, workspace: "none" }} />);
    expect(row("网络").textContent).toBe("不联网仅声明");
    expect(row("环境变量").textContent).toBe("只有系统基础变量已强制");
    expect(screen.queryByText("项目文件")).toBeNull();
  });

  it("explains the labels and warns when a limit rests on the plugin", () => {
    render(<EnforcementLegend declared language="en" />);
    expect(screen.getByText(/Code running as the same user may still get more/)).toBeTruthy();
    expect(screen.getByText("The limits marked “declared only” rest on the plugin keeping to them on this computer.")).toBeTruthy();
  });

  it("names skill scripts that run outside every declaration", () => {
    render(<SkillScriptsNote language="en" scripts={["skills/fetch/run.py"]} />);
    expect(screen.getByText(/they get the full environment/).textContent).toContain("skills/fetch/run.py");
  });

  it("highlights what an upgrade gives a server, and not what it takes away", () => {
    render(<CapabilityChanges server="crossref" language="en" changes={[
      { item: "network", from: "none", to: "required", expands: true },
      { item: "hosts", from: "api.crossref.org", to: "*", expands: true },
      { item: "env", added: [], removed: ["OLD_TOKEN"], expands: false },
    ]} />);
    const items = within(screen.getByRole("list", { name: "crossref · Capability changes" })).getAllByRole("listitem");
    expect(items.map((item) => item.className)).toEqual(["is-expands", "is-expands", ""]);
    expect(items[1].textContent).toContain("api.crossref.org → any address");
    expect(items[2].textContent).toContain("− OLD_TOKEN");
  });

  it("says in words that an upgrade adds a declaration instead of showing a boolean", () => {
    render(<CapabilityChanges server="qqfarm" language="cn" changes={[{ item: "declaration", from: "false", to: "true", expands: false }]} />);
    const item = within(screen.getByRole("list", { name: "qqfarm · 能力变化" })).getByRole("listitem");
    expect(item.textContent).toContain("新版本写明了它需要什么");
    expect(item.textContent).not.toContain("false");
  });
});
