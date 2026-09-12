// Action bar shown under a committed selection: annotation tools, their style
// controls, undo/redo, and the three ways out (cancel, copy, attach).
//
// Icons are inline rather than from `SvgIcon` because this palette (marker,
// mosaic, arrow…) exists nowhere else in the product.

import type { AnnotationTool } from "./annotations";
import { ANNOTATION_COLORS, ANNOTATION_WIDTHS } from "./annotations";

export interface ToolbarCopy {
  rect: string;
  ellipse: string;
  arrow: string;
  pen: string;
  highlight: string;
  mosaic: string;
  text: string;
  undo: string;
  redo: string;
  color: string;
  width: string;
  cancel: string;
  copy: string;
  pin: string;
  attach: string;
}

interface Props {
  copy: ToolbarCopy;
  tool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool | null) => void;
  color: string;
  onColorChange: (color: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCancel: () => void;
  onCopy: () => void;
  onPin: () => void;
  onAttach: () => void;
  busy: boolean;
}

const TOOL_ICONS: Record<AnnotationTool, JSX.Element> = {
  rect: <rect x="3.5" y="5.5" width="15" height="11" rx="1.5" />,
  ellipse: <ellipse cx="11" cy="11" rx="7.5" ry="5.5" />,
  arrow: (
    <>
      <path d="M4 18 L17 5" />
      <path d="M11 5 H17 V11" />
    </>
  ),
  pen: (
    <>
      <path d="M4 18c3-1 3.5-4 6-6.5L14 8" />
      <path d="M12.5 5.5l4 4 -2.5 2.5 -4-4z" />
    </>
  ),
  highlight: (
    <>
      <path d="M6 14l6-6 4 4-6 6H6z" />
      <path d="M4 19h14" strokeWidth="2.6" />
    </>
  ),
  mosaic: (
    <>
      <rect x="4" y="4" width="5" height="5" />
      <rect x="13" y="4" width="5" height="5" />
      <rect x="4" y="13" width="5" height="5" />
      <rect x="13" y="13" width="5" height="5" />
    </>
  ),
  text: (
    <>
      <path d="M4 6V4.5h14V6" />
      <path d="M11 4.5V18" />
      <path d="M8 18h6" />
    </>
  ),
};

const TOOL_ORDER: AnnotationTool[] = [
  "rect",
  "ellipse",
  "arrow",
  "pen",
  "highlight",
  "mosaic",
  "text",
];

function ToolIcon({ tool }: { tool: AnnotationTool }) {
  return (
    <svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {TOOL_ICONS[tool]}
    </svg>
  );
}

export default function ScreenshotToolbar({
  copy,
  tool,
  onToolChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onCancel,
  onCopy,
  onPin,
  onAttach,
  busy,
}: Props) {
  return (
    // The bar sits over the frozen capture; swallow the events it is drawn on
    // so clicking a tool never starts a new selection underneath.
    <div
      className="screenshot-toolbar"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="screenshot-toolbar-group" role="radiogroup" aria-label={copy.text}>
        {TOOL_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={tool === item}
            aria-label={copy[item]}
            title={copy[item]}
            className={`screenshot-tool${tool === item ? " is-active" : ""}`}
            // Toggling off returns the pointer to moving/resizing the selection.
            onClick={() => onToolChange(tool === item ? null : item)}
          >
            <ToolIcon tool={item} />
          </button>
        ))}
      </div>

      <span className="screenshot-toolbar-divider" aria-hidden="true" />

      <div className="screenshot-toolbar-group" role="radiogroup" aria-label={copy.width}>
        {ANNOTATION_WIDTHS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={width === value}
            aria-label={`${copy.width} ${value}`}
            title={`${copy.width} ${value}`}
            className={`screenshot-width${width === value ? " is-active" : ""}`}
            onClick={() => onWidthChange(value)}
          >
            <i style={{ width: value + 2, height: value + 2 }} />
          </button>
        ))}
      </div>

      <div className="screenshot-toolbar-group" role="radiogroup" aria-label={copy.color}>
        {ANNOTATION_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={`${copy.color} ${value}`}
            title={value}
            className={`screenshot-color${color === value ? " is-active" : ""}`}
            style={{ background: value }}
            onClick={() => onColorChange(value)}
          />
        ))}
      </div>

      <span className="screenshot-toolbar-divider" aria-hidden="true" />

      <div className="screenshot-toolbar-group">
        <button
          type="button"
          className="screenshot-tool"
          aria-label={copy.undo}
          title={copy.undo}
          disabled={!canUndo}
          onClick={onUndo}
        >
          <svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7H14a4 4 0 0 1 0 8h-3" />
            <path d="M10 4L7 7l3 3" />
          </svg>
        </button>
        <button
          type="button"
          className="screenshot-tool"
          aria-label={copy.redo}
          title={copy.redo}
          disabled={!canRedo}
          onClick={onRedo}
        >
          <svg viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 7H8a4 4 0 0 0 0 8h3" />
            <path d="M12 4l3 3-3 3" />
          </svg>
        </button>
      </div>

      <span className="screenshot-toolbar-divider" aria-hidden="true" />

      <div className="screenshot-toolbar-group">
        <button type="button" className="screenshot-action" onClick={onCancel}>
          {copy.cancel}
        </button>
        <button type="button" className="screenshot-action" onClick={onCopy} disabled={busy}>
          {copy.copy}
        </button>
        <button type="button" className="screenshot-action" onClick={onPin} disabled={busy}>
          {copy.pin}
        </button>
        <button
          type="button"
          className="screenshot-action is-primary"
          onClick={onAttach}
          disabled={busy}
        >
          {copy.attach}
        </button>
      </div>
    </div>
  );
}
