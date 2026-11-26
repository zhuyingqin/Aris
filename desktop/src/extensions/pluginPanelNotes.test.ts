import { describe, expect, it } from "vitest";
import { panelCapabilityNotes } from "./pluginPanelNotes";

describe("panelCapabilityNotes", () => {
  it("says a page has no direct network access when its package embeds no site", () => {
    const [note] = panelCapabilityNotes([{ title: "Board", page: true }], "en");
    expect(note).toBe("Board (own page: runs the package's page code, sandboxed, no direct network access)");
  });

  it("names the site a page can hand its data to, whichever panel of the package embeds it", () => {
    const notes = panelCapabilityNotes([
      { title: { en: "Console", cn: "控制台" }, page: true, proposeTasks: true },
      { title: { en: "Farm", cn: "农场" }, web: "http://127.0.0.1:3007" },
    ], "cn");
    expect(notes[0]).toBe("控制台（自绘页面：运行插件自带的页面代码，在沙箱内，不能直接联网；但它能把面板数据交给本插件嵌入的网页 http://127.0.0.1:3007）（可提议后台任务，每次都需你确认）");
    expect(notes[1]).toBe("农场（嵌入网页：http://127.0.0.1:3007）");
  });

  it("names every tool a panel runs without a conversation, and those its page runs unasked", () => {
    const [sidebar, page] = panelCapabilityNotes([
      { title: "Farm", tools: [{ name: "farm_start" }, { name: "farm_stop" }] },
      { title: "Console", page: true, tools: [{ name: "farm_start" }, { name: "farm_status", auto: true }] },
    ], "cn");
    expect(sidebar).toBe("Farm（点按钮可不经对话直接运行本插件的工具：farm_start、farm_stop）");
    expect(page).toContain("（点按钮可不经对话直接运行本插件的工具：farm_start、farm_status；其中 farm_status 页面可自行运行，不需要你点击）");
    const [english] = panelCapabilityNotes([{ title: "Farm", tools: [{ name: "farm_status", auto: true }] }], "en");
    expect(english).toBe("Farm (a click runs this package's tools directly, with no conversation: farm_status; the page may run farm_status by itself, without your click)");
  });

  it("lists the page, the site and tasks of one panel that combines them", () => {
    const [note] = panelCapabilityNotes([{ title: "Console", page: true, web: "http://localhost:3007", proposeTasks: true }], "en");
    expect(note).toContain("it can hand panel data to the web page this package embeds: http://localhost:3007");
    expect(note).toContain("(embeds the web page http://localhost:3007)");
    expect(note).toContain("(may propose background tasks; you confirm each one)");
  });
});
