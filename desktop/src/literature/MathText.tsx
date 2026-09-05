import katex from "katex";
import "katex/dist/katex.min.css";
import { wrapBareDisplayMathEnvironments } from "../math/latexMath";

interface MathTextProps {
  text: string;
  className?: string;
}

interface MathSegment {
  kind: "text" | "math";
  content: string;
  display: boolean;
}

const DELIMITED_MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\))/g;
const IMPLICIT_MATH =
  /(?:\\[A-Za-z]+|[A-Za-zΑ-Ωα-ω][\u0302\u0304\u0303]?)[A-Za-zΑ-Ωα-ω0-9_^{},()[\].\\\s]*[=≈≠≤≥<>+\-*/][A-Za-zΑ-Ωα-ω0-9_^{},()[\].\\\s]+/g;

const normalizeUnicodeMath = (value: string) =>
  value
    .replace(/([A-Za-zΑ-Ωα-ω])\u0302/g, "\\hat{$1}")
    .replace(/([A-Za-zΑ-Ωα-ω])\u0304/g, "\\bar{$1}")
    .replace(/([A-Za-zΑ-Ωα-ω])\u0303/g, "\\tilde{$1}")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≠/g, "\\ne ")
    .replace(/≈/g, "\\approx ")
    .replace(/×/g, "\\times ")
    .replace(/÷/g, "\\div ")
    .replace(/∞/g, "\\infty ")
    .replace(/∑/g, "\\sum ")
    .replace(/∏/g, "\\prod ")
    .replace(/∫/g, "\\int ")
    .replace(/√/g, "\\sqrt ")
    .replace(/\u200b/g, "")
    .trim();

const looksLikeStandaloneMath = (value: string) => {
  const text = value.trim();
  if (!text || text.length > 500 || /[\u3400-\u9fff]/.test(text)) return false;
  const hasOperator = /[=<>+\-*/≈≠≤≥∑∏∫√]|\\(?:frac|sum|prod|int|sqrt|hat|bar|tilde)\b/.test(text);
  const hasStructure = /[_^()[\]{}]|[A-Za-zΑ-Ωα-ω]\u0302|\\[A-Za-z]+/.test(text);
  const proseWords = text.match(/[A-Za-z]{4,}/g)?.length ?? 0;
  return hasOperator && hasStructure && proseWords <= 2;
};

const delimitedSegment = (value: string): MathSegment => {
  if (value.startsWith("$$")) {
    return { kind: "math", content: value.slice(2, -2), display: true };
  }
  if (value.startsWith("\\[")) {
    return { kind: "math", content: value.slice(2, -2), display: true };
  }
  if (value.startsWith("\\(")) {
    return { kind: "math", content: value.slice(2, -2), display: false };
  }
  return { kind: "math", content: value.slice(1, -1), display: false };
};

const parseMathSegments = (value: string): MathSegment[] => {
  const segments: MathSegment[] = [];
  let offset = 0;
  let foundDelimitedMath = false;
  for (const match of value.matchAll(DELIMITED_MATH)) {
    foundDelimitedMath = true;
    const index = match.index ?? 0;
    if (index > offset) {
      segments.push({ kind: "text", content: value.slice(offset, index), display: false });
    }
    segments.push(delimitedSegment(match[0]));
    offset = index + match[0].length;
  }
  if (!foundDelimitedMath) {
    if (looksLikeStandaloneMath(value)) {
      return [{ kind: "math", content: value, display: true }];
    }
    const implicitSegments: MathSegment[] = [];
    let implicitOffset = 0;
    for (const match of value.matchAll(IMPLICIT_MATH)) {
      if (!looksLikeStandaloneMath(match[0])) continue;
      const index = match.index ?? 0;
      if (index > implicitOffset) {
        implicitSegments.push({
          kind: "text",
          content: value.slice(implicitOffset, index),
          display: false,
        });
      }
      implicitSegments.push({ kind: "math", content: match[0].trim(), display: false });
      implicitOffset = index + match[0].length;
    }
    if (implicitSegments.length === 0) {
      return [{ kind: "text", content: value, display: false }];
    }
    if (implicitOffset < value.length) {
      implicitSegments.push({
        kind: "text",
        content: value.slice(implicitOffset),
        display: false,
      });
    }
    return implicitSegments;
  }
  if (offset < value.length) {
    segments.push({ kind: "text", content: value.slice(offset), display: false });
  }
  return segments;
};

function Formula({ source, display }: { source: string; display: boolean }) {
  const latex = normalizeUnicodeMath(source);
  try {
    const html = katex.renderToString(latex, {
      displayMode: display,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
    return (
      <span
        className={`lit-math-formula${display ? " display" : ""}`}
        role="math"
        aria-label={source.trim()}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return <span className="lit-math-fallback">{source}</span>;
  }
}

export default function MathText({ text, className = "" }: MathTextProps) {
  const normalizedText = wrapBareDisplayMathEnvironments(text);
  return (
    <span className={`lit-math-text ${className}`.trim()}>
      {parseMathSegments(normalizedText).map((segment, index) =>
        segment.kind === "math"
          ? <Formula key={index} source={segment.content} display={segment.display} />
          : <span key={index}>{segment.content}</span>,
      )}
    </span>
  );
}
