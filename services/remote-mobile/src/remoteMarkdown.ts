export type RemoteMarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "unordered_list"; items: string[] }
  | { kind: "ordered_list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "divider" }
  | { kind: "paragraph"; text: string };

/**
 * Projects can return Markdown-like assistant replies. Parse only the
 * presentation structures the mobile shell can render safely; HTML is never
 * interpreted and all strings remain text nodes.
 */
export function parseRemoteMarkdown(text: string): RemoteMarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RemoteMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1].trim(), text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^[-*+]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "unordered_list", items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\d+[.)]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "ordered_list", items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim().length > 0 && !beginsRemoteMarkdownBlock(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      continue;
    }

    blocks.push({ kind: "paragraph", text: lines[index] });
    index += 1;
  }

  return blocks;
}

export function renderRemoteMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseRemoteMarkdown(text)) {
    switch (block.kind) {
      case "heading": {
        const heading = document.createElement(block.level === 1 ? "h2" : "h3");
        appendInlineMarkdown(heading, block.text);
        fragment.append(heading);
        break;
      }
      case "unordered_list": {
        const list = document.createElement("ul");
        for (const item of block.items) {
          const entry = document.createElement("li");
          appendInlineMarkdown(entry, item);
          list.append(entry);
        }
        fragment.append(list);
        break;
      }
      case "ordered_list": {
        const list = document.createElement("ol");
        for (const item of block.items) {
          const entry = document.createElement("li");
          appendInlineMarkdown(entry, item);
          list.append(entry);
        }
        fragment.append(list);
        break;
      }
      case "quote": {
        const quote = document.createElement("blockquote");
        appendInlineMarkdown(quote, block.text);
        fragment.append(quote);
        break;
      }
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (block.language) code.dataset.language = block.language;
        code.textContent = block.text;
        pre.append(code);
        fragment.append(pre);
        break;
      }
      case "divider":
        fragment.append(document.createElement("hr"));
        break;
      case "paragraph": {
        const paragraph = document.createElement("p");
        appendInlineMarkdown(paragraph, block.text);
        fragment.append(paragraph);
        break;
      }
    }
  }
  return fragment;
}

function beginsRemoteMarkdownBlock(line: string): boolean {
  return /^```|^(#{1,3})\s+|^(?:\*{3,}|-{3,}|_{3,})\s*$|^>\s?|^[-*+]\s+|^\d+[.)]\s+/.test(line);
}

function appendInlineMarkdown(target: HTMLElement, text: string): void {
  const token = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const offset = match.index ?? 0;
    appendPlainText(target, text.slice(cursor, offset));
    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[1];
      target.append(code);
    } else if (match[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      target.append(strong);
    } else {
      const href = safeRemoteHref(match[4]);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = match[3];
        target.append(link);
      } else {
        appendPlainText(target, match[3]);
      }
    }
    cursor = offset + match[0].length;
  }
  appendPlainText(target, text.slice(cursor));
}

function appendPlainText(target: HTMLElement, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) target.append(document.createElement("br"));
    if (line) target.append(document.createTextNode(line));
  });
}

function safeRemoteHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
