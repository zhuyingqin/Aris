import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import MarkdownContent from "../chat/MarkdownContent";
import type { CellOutput } from "./labTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function outputRecord(output: CellOutput): Record<string, unknown> {
  return output as unknown as Record<string, unknown>;
}

/** Both the kernel (`type`) and on-disk nbformat (`output_type`) shapes flow here. */
function outputKind(output: CellOutput): string | null {
  const raw = outputRecord(output);
  if (typeof raw.type === "string") return raw.type;
  if (typeof raw.output_type === "string") return raw.output_type;
  return null;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : String(item))).join("");
  if (value === null || value === undefined) return "";
  return String(value);
}

function outputData(output: CellOutput): Record<string, unknown> {
  const data = outputRecord(output).data;
  return isRecord(data) ? data : {};
}

// ── ANSI rendering ───────────────────────────────────────────────────────────
// Stream logs and IPython tracebacks are full of ANSI SGR escapes. Rather than
// strip them (losing all the structure colour carries), translate the common
// codes into themed spans so a traceback reads like it does in Jupyter.

interface AnsiStyle {
  color?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "underline";
  opacity?: number;
}

const ANSI_FG: Record<number, string> = {
  30: "var(--text-dim)", 31: "var(--red)", 32: "var(--green)", 33: "var(--amber)",
  34: "var(--blue)", 35: "var(--accent-2)", 36: "var(--accent)", 37: "var(--text)",
  90: "var(--gray)", 91: "var(--red)", 92: "var(--green)", 93: "var(--amber)",
  94: "var(--blue)", 95: "var(--accent-2)", 96: "var(--accent)", 97: "var(--text)",
};

function ansiToNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\x1b\[([0-9;]*)m/g; // eslint-disable-line no-control-regex
  let style: AnsiStyle = {};
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  const push = (chunk: string) => {
    if (!chunk) return;
    nodes.push(
      Object.keys(style).length === 0 ? (
        chunk
      ) : (
        <span key={key++} style={{ ...style }}>
          {chunk}
        </span>
      ),
    );
  };

  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(cursor, match.index));
    cursor = pattern.lastIndex;
    const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) style = {};
      else if (code === 1) style.fontWeight = "bold";
      else if (code === 2) style.opacity = 0.7;
      else if (code === 3) style.fontStyle = "italic";
      else if (code === 4) style.textDecoration = "underline";
      else if (code === 22) {
        delete style.fontWeight;
        delete style.opacity;
      } else if (code === 23) delete style.fontStyle;
      else if (code === 24) delete style.textDecoration;
      else if (code === 39) delete style.color;
      else if (ANSI_FG[code]) style.color = ANSI_FG[code];
      else if (code === 38 || code === 48) {
        // Extended colour: skip its operands (5;n or 2;r;g;b) — keep it readable.
        i += codes[i + 1] === 2 ? 4 : 2;
      }
      // Background codes (40–47 / 100–107) are intentionally ignored for legibility.
    }
  }
  push(text.slice(cursor));
  return nodes;
}

export function AnsiText({ text, className }: { text: string; className?: string }) {
  return <pre className={className ?? "lab-out"}>{ansiToNodes(text)}</pre>;
}

// ── Rich MIME bundle ─────────────────────────────────────────────────────────
// execute_result / display_data carry a bundle of representations; render the
// richest one we support. HTML covers pandas DataFrames and most rich reprs.
// NOTE: HTML/SVG come from the user's own kernel (same trust model as Jupyter
// running locally), so we render them as-is.

function RichData({ data }: { data: Record<string, unknown> }) {
  const html = outputText(data["text/html"]);
  if (html.trim()) return <div className="lab-out-html" dangerouslySetInnerHTML={{ __html: html }} />;

  const svg = outputText(data["image/svg+xml"]);
  if (svg.trim()) return <div className="lab-out-svg" dangerouslySetInnerHTML={{ __html: svg }} />;

  const png = outputText(data["image/png"]);
  if (png) return <img className="lab-out-img" src={`data:image/png;base64,${png}`} alt="cell output" />;

  const jpeg = outputText(data["image/jpeg"]);
  if (jpeg) return <img className="lab-out-img" src={`data:image/jpeg;base64,${jpeg}`} alt="cell output" />;

  const markdown = outputText(data["text/markdown"]);
  if (markdown.trim()) {
    return (
      <div className="lab-out-rich-md">
        <MarkdownContent text={markdown} />
      </div>
    );
  }

  const json = data["application/json"];
  if (json !== undefined) {
    return <pre className="lab-out lab-out-json">{JSON.stringify(json, null, 2)}</pre>;
  }

  const plain = outputText(data["text/plain"]);
  if (plain) return <AnsiText className="lab-out" text={plain} />;

  if (Object.keys(data).length > 0) {
    return <pre className="lab-out">{JSON.stringify(data, null, 2)}</pre>;
  }
  return null;
}

export function OutputView({ output }: { output: CellOutput }) {
  const raw = outputRecord(output);
  const kind = outputKind(output);

  // A `clear` signal is consumed upstream (it empties the cell); if one ever
  // reaches here, render nothing rather than a stray box.
  if (kind === "clear") return null;

  if (kind === "stream") {
    const name = raw.name === "stderr" ? "stderr" : "stdout";
    return <AnsiText className={`lab-out lab-out-${name}`} text={outputText(raw.text)} />;
  }

  if (kind === "error") {
    const traceback = Array.isArray(raw.traceback) ? raw.traceback.map(outputText).join("\n") : "";
    const text = traceback.trim() || `${outputText(raw.ename)}: ${outputText(raw.evalue)}`.trim();
    return <AnsiText className="lab-out lab-out-error" text={text} />;
  }

  return <RichData data={outputData(output)} />;
}

/** Height at which a cell's combined output is capped and a toggle appears. */
const OUTPUT_CAP_PX = 420;

/**
 * Renders a cell's outputs, capping very tall output with a fade + "Show full
 * output" toggle so one huge dump (a big array print, a long traceback) can't
 * blow out the notebook scroll. Re-measures on every streamed output change.
 */
export function OutputGroup({ outputs }: { outputs: CellOutput[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > OUTPUT_CAP_PX + 8);
  }, [outputs]);

  const capped = overflowing && !expanded;
  return (
    <div className="lab-out-group">
      <div ref={bodyRef} className={capped ? "lab-out-group-body capped" : "lab-out-group-body"}>
        {outputs.map((output, index) => (
          <OutputView key={index} output={output} />
        ))}
      </div>
      {overflowing && (
        <button type="button" className="lab-out-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Collapse output" : "Show full output"}
        </button>
      )}
    </div>
  );
}
