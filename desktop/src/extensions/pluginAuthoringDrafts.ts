import { pluginPathKey, type InstalledPlugin } from "../api/plugins";
import type { Language } from "../store";

/**
 * Drafts the Plugins page puts in a new chat's composer. They are drafts, not
 * messages: the user reads, edits and sends them, and the agent then works
 * through the somniq-plugin-development skill (the plugin-writing route also
 * picks up the word "plugin" / "插件").
 */

const DRAFTS_DIR = ".somniq/plugin-drafts/<short-name>";

export function pluginCreationDraft(language: Language): string {
  return language === "cn"
    ? "请用 somniq-plugin-development 技能帮我做一个插件：\n（在这里写你想要什么，例如“一个记录实验假设的侧栏面板”，或“把 scripts/xxx.py 包成 MCP 工具”）"
    : "Use the somniq-plugin-development skill to build me a plugin:\n(describe what you want, e.g. \"a Chat sidebar panel for logging experiment hypotheses\" or \"wrap scripts/xxx.py as an MCP tool\")";
}

/** A package that cannot run, or whose MCP servers failed, is worth a repair. */
export function pluginNeedsRepair(item: InstalledPlugin): boolean {
  const state = item.lifecycle?.state;
  return state === "blocked" || state === "failed" || item.status === "blocked" || !item.canEnable;
}

function insideProject(source: string, projectPath: string): boolean {
  const project = pluginPathKey(projectPath);
  const path = pluginPathKey(source);
  return Boolean(project) && (path === project || path.startsWith(`${project}/`));
}

export function pluginRepairDraft(item: InstalledPlugin, projectPath: string, language: Language): string {
  const cn = language === "cn";
  const problems = item.diagnostics
    .filter((diagnostic) => diagnostic.code !== "approval-required")
    .map((diagnostic) => {
      const where = [diagnostic.file, diagnostic.path].filter(Boolean).join(" ");
      return `- [${diagnostic.code}] ${diagnostic.message}${where ? ` (${where})` : ""}`;
    });
  const failedServers = (item.lifecycle?.mcpServers ?? [])
    .filter((server) => server.health === "failed")
    .map((server) => `- MCP ${server.name}: ${server.message ?? (cn ? "连接失败" : "connection failed")}`);
  const lines = cn
    ? [
      `请用 somniq-plugin-development 技能修复插件 ${item.name}（v${item.version}）。`,
      `来源目录：${item.source}`,
      `现在的状态：${item.lifecycle?.state ?? item.status}`,
    ]
    : [
      `Use the somniq-plugin-development skill to fix the plugin ${item.name} (v${item.version}).`,
      `Source directory: ${item.source}`,
      `Current state: ${item.lifecycle?.state ?? item.status}`,
    ];
  if (problems.length > 0 || failedServers.length > 0) {
    lines.push(cn ? "问题：" : "Problems:", ...problems, ...failedServers);
  }
  if (!insideProject(item.source, projectPath)) {
    lines.push(cn
      ? `这个来源目录不在当前项目里。先把它复制到 ${DRAFTS_DIR}/，再在那里修改。`
      : `That source directory is outside this project. Copy it into ${DRAFTS_DIR}/ first and fix it there.`);
  }
  lines.push(cn
    ? "在同一个草稿目录里修好，预览到没有诊断后用 upgrade 升级，不要另起一个新名字的包。"
    : "Fix it in that one draft directory, preview until there are no diagnostics, then upgrade; do not create a package under a new name.");
  return lines.join("\n");
}
