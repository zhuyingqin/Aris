import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { wrapBareDisplayMathEnvironments } from "../math/latexMath";

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

/** Display model transcriptions without interpreting embedded HTML or fetching images. */
export default function PaperReadingContent({ content }: { content: string }) {
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
        {displayMathMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}
