export type RemoteMarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "unordered_list"; items: string[] }
  | { kind: "ordered_list"; items: string[] }
  | { kind: "task_list"; ordered: boolean; items: Array<{ text: string; checked: boolean }> }
  | { kind: "table"; headers: string[]; rows: string[][] }
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

    const table = parseRemoteMarkdownTable(lines, index);
    if (table) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = parseRemoteMarkdownTableRow(lines[index]);
        if (!row) break;
        rows.push(normalizeRemoteMarkdownTableRow(row, table.headers.length));
        index += 1;
      }
      blocks.push({ kind: "table", headers: table.headers, rows });
      continue;
    }

    const taskList = parseRemoteMarkdownTaskList(lines, index);
    if (taskList) {
      blocks.push(taskList.block);
      index = taskList.nextIndex;
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
    while (index < lines.length && lines[index].trim().length > 0 && !beginsRemoteMarkdownBlock(lines, index)) {
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
      case "task_list": {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        list.className = "remote-markdown-task-list";
        for (const item of block.items) {
          const entry = document.createElement("li");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = item.checked;
          checkbox.disabled = true;
          checkbox.tabIndex = -1;
          checkbox.setAttribute("aria-label", item.checked ? "Completed task" : "Open task");
          const content = document.createElement("span");
          appendInlineMarkdown(content, item.text);
          entry.append(checkbox, content);
          list.append(entry);
        }
        fragment.append(list);
        break;
      }
      case "table": {
        const scroll = document.createElement("div");
        scroll.className = "remote-markdown-table-scroll";
        const table = document.createElement("table");
        table.className = "remote-markdown-table";
        const head = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (const header of block.headers) {
          const cell = document.createElement("th");
          cell.scope = "col";
          appendInlineMarkdown(cell, header);
          headerRow.append(cell);
        }
        head.append(headerRow);
        table.append(head);

        if (block.rows.length > 0) {
          const body = document.createElement("tbody");
          for (const row of block.rows) {
            const tableRow = document.createElement("tr");
            for (const value of row) {
              const cell = document.createElement("td");
              appendInlineMarkdown(cell, value);
              tableRow.append(cell);
            }
            body.append(tableRow);
          }
          table.append(body);
        }

        scroll.append(table);
        fragment.append(scroll);
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

function beginsRemoteMarkdownBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^```|^(#{1,3})\s+|^(?:\*{3,}|-{3,}|_{3,})\s*$|^>\s?|^[-*+]\s+|^\d+[.)]\s+/.test(line)
    || parseRemoteMarkdownTable(lines, index) !== null;
}

function appendInlineMarkdown(target: HTMLElement, text: string): void {
  const token = /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^()\s]+)\)|\[([^\]\n]+)\]\(([^()\s]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const offset = match.index ?? 0;
    appendPlainText(target, text.slice(cursor, offset));
    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[1];
      target.append(code);
    } else if (match[2] !== undefined) {
      const src = safeRemoteUrl(match[3]);
      if (src) {
        const image = document.createElement("img");
        image.src = src;
        image.alt = match[2];
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        target.append(image);
      } else {
        appendPlainText(target, match[0]);
      }
    } else if (match[4] !== undefined) {
      const href = safeRemoteUrl(match[5]);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[4];
        target.append(link);
      } else {
        appendPlainText(target, match[0]);
      }
    } else if (match[6] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[6];
      target.append(strong);
    } else if (match[7] !== undefined) {
      const deleted = document.createElement("del");
      deleted.textContent = match[7];
      target.append(deleted);
    } else if (match[8] !== undefined || match[9] !== undefined) {
      const value = match[8] ?? match[9] ?? "";
      if (isInlineWordBoundary(text, offset, match[0].length)) {
        const emphasis = document.createElement("em");
        emphasis.textContent = value;
        target.append(emphasis);
      } else {
        appendPlainText(target, match[0]);
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

function parseRemoteMarkdownTaskList(
  lines: string[],
  index: number,
): { block: Extract<RemoteMarkdownBlock, { kind: "task_list" }>; nextIndex: number } | null {
  const first = parseRemoteMarkdownTaskListItem(lines[index]);
  if (!first) return null;

  const items = [first.item];
  let nextIndex = index + 1;
  while (nextIndex < lines.length) {
    const next = parseRemoteMarkdownTaskListItem(lines[nextIndex]);
    if (!next || next.ordered !== first.ordered) break;
    items.push(next.item);
    nextIndex += 1;
  }

  return {
    block: { kind: "task_list", ordered: first.ordered, items },
    nextIndex,
  };
}

function parseRemoteMarkdownTaskListItem(
  line: string,
): { ordered: boolean; item: { text: string; checked: boolean } } | null {
  const unordered = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
  if (unordered) {
    return { ordered: false, item: { checked: unordered[1].toLowerCase() === "x", text: unordered[2] } };
  }

  const ordered = /^\d+[.)]\s+\[([ xX])\]\s*(.*)$/.exec(line);
  if (!ordered) return null;
  return { ordered: true, item: { checked: ordered[1].toLowerCase() === "x", text: ordered[2] } };
}

function parseRemoteMarkdownTable(
  lines: string[],
  index: number,
): { headers: string[] } | null {
  if (index + 1 >= lines.length) return null;
  const headers = parseRemoteMarkdownTableRow(lines[index]);
  const separator = parseRemoteMarkdownTableRow(lines[index + 1]);
  if (!headers || !separator || headers.length === 0 || headers.length !== separator.length) return null;
  if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) return null;
  return { headers };
}

function parseRemoteMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;

  const row = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of row) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function normalizeRemoteMarkdownTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function isInlineWordBoundary(text: string, offset: number, length: number): boolean {
  const before = offset > 0 ? text[offset - 1] : "";
  const after = text[offset + length] ?? "";
  return !isInlineWordCharacter(before) && !isInlineWordCharacter(after);
}

function isInlineWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}

export function safeRemoteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0
      ? url.href
      : null;
  } catch {
    return null;
  }
}
