import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { wrapBareDisplayMathEnvironments } from "../math/latexMath";

const READABLE_PROSE_MIN_LENGTH = 180;
const READABLE_PARAGRAPH_TARGET = 140;
const READABLE_PARAGRAPH_MAX = 230;

function sentenceChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let mathDelimiter = 0;
  let inlineCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`" && mathDelimiter === 0) {
      inlineCode = !inlineCode;
      continue;
    }
    if (character === "$" && !inlineCode) {
      const delimiter = text[index + 1] === "$" ? 2 : 1;
      mathDelimiter = mathDelimiter === delimiter ? 0 : mathDelimiter === 0 ? delimiter : mathDelimiter;
      index += delimiter - 1;
      continue;
    }
    if (mathDelimiter || inlineCode) continue;
    const chineseStop = /[。！？]/.test(character);
    const westernStop = /[.!?]/.test(character) && /\s/.test(text[index + 1] ?? "");
    if (!chineseStop && !westernStop) continue;
    let end = index + 1;
    while (/[”’》〉」』)\]]/.test(text[end] ?? "")) end += 1;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    while (/\s/.test(text[end] ?? "")) end += 1;
    start = end;
    index = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) chunks.push(tail);
  return chunks;
}

/** Add visual breathing room to legacy model prose without rewriting its words. */
function readableProseMarkdown(markdown: string): string {
  let fenced = false;
  return markdown.split("\n").map(line => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.test(line);
    if (fence) {
      fenced = !fenced;
      return line;
    }
    const text = line.trim();
    if (fenced || text.length < READABLE_PROSE_MIN_LENGTH
      || /^(?:#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s|\||\$\$)/.test(text)) return line;
    const sentences = sentenceChunks(text);
    if (sentences.length < 2) return line;
    const paragraphs: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      if (current && (current.length >= READABLE_PARAGRAPH_TARGET
        || current.length + sentence.length + 1 > READABLE_PARAGRAPH_MAX)) {
        paragraphs.push(current);
        current = "";
      }
      current += `${current ? " " : ""}${sentence}`;
    }
    if (current) paragraphs.push(current);
    return paragraphs.length > 1 ? paragraphs.join("\n\n") : line;
  }).join("\n");
}

/** Normalize display delimiters in prose without touching fenced code samples. */
function displayMathMarkdown(content: string): string {
  const output: string[] = [];
  const prose: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  const flush = () => {
    if (!prose.length) return;
    output.push(wrapBareDisplayMathEnvironments(prose.join("\n").replace(
      /^[ \t]{0,3}\$\$([^\n]+?)\$\$[ \t]*$/gm,
      (_match, formula: string) => `$$\n${formula.trim()}\n$$`,
    )));
    prose.length = 0;
  };
  for (const line of content.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      output.push(line);
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (delimiter) {
      flush();
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      output.push(line);
    } else prose.push(line);
  }
  flush();
  return output.join("\n");
}

/** Display model text without interpreting embedded HTML or fetching images. */
export default function PaperReadingContent({ content, readableProse = false }: { content: string; readableProse?: boolean }) {
  const markdown = displayMathMarkdown(content);
  return (
    <div className="lit-paper-reading-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore" }]]}
        components={{
          table: ({ children }) => <div className="lit-paper-reading-table"><table>{children}</table></div>,
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {readableProse ? readableProseMarkdown(markdown) : markdown}
      </ReactMarkdown>
    </div>
  );
}
