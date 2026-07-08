import { describe, expect, it } from "vitest";

import apiSource from "../api/tauri.ts?raw";
import chatMessageSource from "./ChatMessage.tsx?raw";
import chatThreadSource from "./ChatThread.tsx?raw";
import { CHAT_COPY } from "./i18n";
import i18nSource from "./i18n.ts?raw";
import { cleanChatTitle } from "./model";
import useChatStreamSource from "./useChatStream.ts?raw";

const MOJIBAKE_TOKENS = [
  "\uFFFD",
  "鈥",
  "鈹",
  "鈫",
  "锟",
  "馃",
  "涓",
  "绗",
  "鏈",
  "鎷",
  "鏂",
  "瀹",
  "鎼",
  "鏃",
  "銆",
  "閰",
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (typeof value === "function") {
    out.push(String((value as (input: string | number) => string)("测试")));
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectStrings(child, out);
  }
  return out;
}

function expectNoMojibake(label: string, text: string) {
  for (const token of MOJIBAKE_TOKENS) {
    expect(text.includes(token), `${label} contains mojibake token ${JSON.stringify(token)}`).toBe(false);
  }
}

describe("chat copy encoding", () => {
  it("keeps critical Chinese copy as UTF-8 text", () => {
    expect(CHAT_COPY.cn.newChat).toBe("新对话");
    expect(CHAT_COPY.cn.messagePlaceholder).toBe("给 SomniQ 发送消息");
    expect(CHAT_COPY.cn.deleted("测试")).toBe("已删除“测试”");
  });

  it("keeps title cleaning compatible with Chinese titles", () => {
    expect(cleanChatTitle("无标题")).toBe("");
    expect(cleanChatTitle("标题：项目结构梳理")).toBe("项目结构梳理");
  });

  it("does not ship common mojibake fragments in chat-facing copy", () => {
    for (const text of collectStrings(CHAT_COPY)) {
      expectNoMojibake("CHAT_COPY", text);
    }
  });

  it("does not contain replacement characters in chat source files", () => {
    const files = [
      ["desktop/src/chat/i18n.ts", i18nSource],
      ["desktop/src/chat/ChatThread.tsx", chatThreadSource],
      ["desktop/src/chat/ChatMessage.tsx", chatMessageSource],
      ["desktop/src/chat/useChatStream.ts", useChatStreamSource],
      ["desktop/src/api/tauri.ts", apiSource],
    ] as const;
    for (const [file, source] of files) {
      expectNoMojibake(file, source);
    }
  });
});
