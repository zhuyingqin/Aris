// What each UI panel of a package can do, as the approval cards tell the user:
// the Chat card and the Plugins page say the same thing in the same words.
import type { UiPanelTool, UiText } from "../api/plugins";
import { tr } from "../language";
import type { Language } from "../store";
import { uiText } from "./useChatPluginPanels";

export interface PanelCapability {
  title: UiText;
  /** An approval card says whether there is a page; an installed panel names its file. */
  page?: boolean | string;
  web?: string | null;
  proposeTasks?: boolean;
  tools?: UiPanelTool[];
}

/** Each panel's title with what it runs, embeds or may ask for. A page runs
 *  sandboxed without a network of its own, but frames in one window can always
 *  message each other: when the package also embeds a site, its page can hand
 *  panel data to that site, so the card names the address. */
export function panelCapabilityNotes(panels: PanelCapability[], language: Language): string[] {
  const sites = [...new Set(panels.flatMap((panel) => panel.web ? [panel.web] : []))];
  return panels.map((panel) => {
    let note = uiText(panel.title, language);
    if (panel.page) {
      note += sites.length
        ? tr(language,
          `（自绘页面：运行插件自带的页面代码，在沙箱内，不能直接联网；但它能把面板数据交给本插件嵌入的网页 ${sites.join("、")}）`,
          ` (own page: runs the package's page code, sandboxed, no direct network access; but it can hand panel data to the web page this package embeds: ${sites.join(", ")})`,
          ` (página propia: ejecuta el código de página del paquete, en un sandbox y sin acceso directo a la red; pero puede pasar los datos del panel a la página web que incrusta este paquete: ${sites.join(", ")})`)
        : tr(language,
          "（自绘页面：运行插件自带的页面代码，在沙箱内，不能直接联网）",
          " (own page: runs the package's page code, sandboxed, no direct network access)",
          " (página propia: ejecuta el código de página del paquete, en un sandbox y sin acceso directo a la red)");
    }
    if (panel.web) {
      note += tr(language, `（嵌入网页：${panel.web}）`, ` (embeds the web page ${panel.web})`, ` (incrusta la página web ${panel.web})`);
    }
    if (panel.proposeTasks) {
      note += tr(language,
        "（可提议后台任务，每次都需你确认）",
        " (may propose background tasks; you confirm each one)",
        " (puede proponer tareas en segundo plano; confirmas cada una)");
    }
    const tools = panel.tools ?? [];
    if (tools.length) {
      // These run the package's own programs on this computer when clicked,
      // with no conversation in between: the card names each one.
      const names = tools.map((tool) => tool.name);
      const auto = tools.filter((tool) => tool.auto).map((tool) => tool.name);
      note += tr(language,
        `（点按钮可不经对话直接运行本插件的工具：${names.join("、")}`,
        ` (a click runs this package's tools directly, with no conversation: ${names.join(", ")}`,
        ` (un clic ejecuta directamente, sin conversación, las herramientas de este paquete: ${names.join(", ")}`);
      if (auto.length) {
        note += tr(language,
          `；其中 ${auto.join("、")} 页面可自行运行，不需要你点击`,
          `; the page may run ${auto.join(", ")} by itself, without your click`,
          `; la página puede ejecutar ${auto.join(", ")} por sí sola, sin tu clic`);
      }
      note += tr(language, "）", ")", ")");
    }
    return note;
  });
}
