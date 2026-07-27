import { useEffect, useMemo, useRef, useState } from "react";

type RenderState =
  | { status: "idle"; svg: string; error: string; width: number; height: number }
  | { status: "loading"; svg: string; error: string; width: number; height: number }
  | { status: "ready"; svg: string; error: string; width: number; height: number }
  | { status: "error"; svg: string; error: string; width: number; height: number };

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

let renderSequence = 0;
let mermaidInitialized = false;

function nextRenderId() {
  renderSequence += 1;
  return `aris-mermaid-${renderSequence}`;
}

async function renderMermaid(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: {
        background: "transparent",
        primaryColor: "#162233",
        primaryTextColor: "#e5edf7",
        primaryBorderColor: "#5b78a0",
        lineColor: "#9fb8d8",
        secondaryColor: "#14251d",
        tertiaryColor: "#2b2416",
        fontFamily: "var(--font-sans)",
        fontSize: "14px",
      },
      flowchart: {
        curve: "basis",
        htmlLabels: false,
        padding: 14,
        useMaxWidth: true,
      },
      sequence: {
        showSequenceNumbers: false,
        useMaxWidth: true,
      },
    });
    mermaidInitialized = true;
  }
  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed) {
    throw new Error("Mermaid syntax error.");
  }
  const result = await mermaid.render(nextRenderId(), code);
  return result.svg;
}

function parseSvgLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]*\.?[0-9]+)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function extractSvgMetrics(svg: string): { svg: string; width: number; height: number } {
  const parser = new DOMParser();
  const document = parser.parseFromString(svg, "image/svg+xml");
  const root = document.querySelector("svg");
  if (!root) {
    return { svg, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const viewBox = root.getAttribute("viewBox");
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map((value) => Number(value));
    if (parts.length === 4 && parts.slice(2).every((value) => Number.isFinite(value) && value > 0)) {
      width = parts[2];
      height = parts[3];
    }
  } else {
    width = parseSvgLength(root.getAttribute("width")) ?? DEFAULT_WIDTH;
    height = parseSvgLength(root.getAttribute("height")) ?? Math.max(DEFAULT_HEIGHT, Math.round(width * 0.56));
  }
  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  root.setAttribute("preserveAspectRatio", "xMidYMin meet");
  root.setAttribute("focusable", "false");
  return {
    svg: new XMLSerializer().serializeToString(root),
    width,
    height,
  };
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value.toFixed(2))));
}

function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export default function MermaidDiagram({
  code,
  streaming = false,
}: {
  code: string;
  streaming?: boolean;
}) {
  const [state, setState] = useState<RenderState>({
    status: "idle",
    svg: "",
    error: "",
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState(1);
  const latestCode = useRef(code);
  latestCode.current = code;
  const stageWidth = Math.max(320, Math.round(state.width * zoom));
  const stageHeight = Math.max(180, Math.round(state.height * zoom));
  const svg = useMemo(() => state.svg, [state.svg]);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      setState({
        status: "idle",
        svg: "",
        error: "",
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      });
      return;
    }

    let cancelled = false;
    const delay = streaming ? 350 : 0;
    setState((previous) => ({
      status: "loading",
      svg: previous.svg,
      error: "",
      width: previous.width,
      height: previous.height,
    }));
    const timeout = window.setTimeout(() => {
      void renderMermaid(trimmed)
        .then((svg) => {
          if (!cancelled && latestCode.current.trim() === trimmed) {
            const metrics = extractSvgMetrics(svg);
            setState({ status: "ready", ...metrics, error: "" });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && latestCode.current.trim() === trimmed) {
            const message = error instanceof Error ? error.message : String(error);
            setState({
              status: "error",
              svg: "",
              error: message,
              width: DEFAULT_WIDTH,
              height: DEFAULT_HEIGHT,
            });
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [code, streaming]);

  const showSource = sourceOpen || state.status === "error";
  const hasDiagram = Boolean(svg) && state.status === "ready";

  return (
    <div className={`md-mermaid${state.status === "error" ? " has-error" : ""}`}>
      <div className="md-mermaid-header">
        <span className="md-mermaid-lang">mermaid</span>
        <div className="md-mermaid-toolbar">
          <div className="md-mermaid-zoom" aria-label="Diagram zoom">
            <button
              type="button"
              className="md-mermaid-zoom-btn"
              title="Zoom out"
              onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
            >
              -
            </button>
            <span className="md-mermaid-zoom-label" title="Current zoom">
              {formatZoom(zoom)}
            </span>
            <button
              type="button"
              className="md-mermaid-zoom-btn"
              title="Zoom in"
              onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
            >
              +
            </button>
            <button
              type="button"
              className="md-mermaid-zoom-btn"
              title="Reset zoom"
              onClick={() => setZoom(1)}
            >
              100%
            </button>
          </div>
          <div className="md-mermaid-actions">
          <button
            type="button"
            className="md-mermaid-btn"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="md-mermaid-btn"
            aria-expanded={showSource}
            onClick={() => setSourceOpen((value) => !value)}
          >
            {showSource ? "Hide source" : "Source"}
          </button>
          </div>
        </div>
      </div>
      <div className="md-mermaid-canvas">
        {state.status === "loading" && !svg && (
          <div className="md-mermaid-placeholder">Rendering diagram...</div>
        )}
        {hasDiagram && (
          <div className="md-mermaid-stage" style={{ width: stageWidth, height: stageHeight }}>
            <div
              className="md-mermaid-diagram"
              data-testid="mermaid-diagram"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
        {state.status === "error" && (
          <div className="md-mermaid-error-wrap">
            <div className="md-mermaid-error-title">Mermaid syntax error</div>
            <div className="md-mermaid-error">
              The diagram was not rendered. Use the source view below to inspect or edit the code.
            </div>
            {state.error && <div className="md-mermaid-error-detail">{state.error}</div>}
          </div>
        )}
      </div>
      {showSource && <pre className="md-mermaid-source">{code}</pre>}
    </div>
  );
}
