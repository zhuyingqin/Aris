import { useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ToolIcon } from "./ToolIcon";
import { basename, sameWorkspacePath } from "./latexText";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { useStore } from "../store";
import type { NumberedOutlineItem } from "./outlineModel";

export const OUTLINE_PANEL_DEFAULT_H = 184;
export const OUTLINE_PANEL_MIN_H = 72;
export const OUTLINE_PANEL_MAX_H = 720;

/** A heading is collapsible when the next item sits deeper than it does. */
function childCountFor(outline: NumberedOutlineItem[], index: number): number {
  let count = 0;
  for (let scan = index + 1; scan < outline.length; scan += 1) {
    if (outline[scan].level <= outline[index].level) break;
    count += 1;
  }
  return count;
}

/** Items hidden because an ancestor is collapsed. Filtering wins over folding:
 * a search has to be able to reach into a folded chapter. */
function hiddenLines(outline: NumberedOutlineItem[], collapsedKeys: Set<string>): Set<number> {
  const hidden = new Set<number>();
  for (let index = 0; index < outline.length; index += 1) {
    if (!collapsedKeys.has(outlineKey(outline[index]))) continue;
    const children = childCountFor(outline, index);
    for (let child = index + 1; child <= index + children; child += 1) hidden.add(child);
  }
  return hidden;
}

export function outlineKey(item: NumberedOutlineItem): string {
  return `${item.file ?? ""}:${item.line}:${item.title}`;
}

export function TypesetOutlinePanel({
  activeLine,
  collapsed,
  currentPath,
  outline,
  height,
  wordCount,
  onJumpToLine,
  onResizeKeyDown,
  onResizePointerDown,
  onToggleCollapsed,
}: {
  activeLine: number | null;
  collapsed: boolean;
  currentPath: string | null;
  outline: NumberedOutlineItem[];
  height: number | null;
  /** Words in the whole document graph, shown next to the heading count. */
  wordCount: number | null;
  onJumpToLine: (line: number, file: string | null) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleCollapsed: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].outline;
  const [filter, setFilter] = useState("");
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const query = filter.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    if (query) {
      return outline
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => `${item.number} ${item.title}`.toLocaleLowerCase().includes(query));
    }
    const hidden = hiddenLines(outline, collapsedKeys);
    return outline
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => !hidden.has(index));
  }, [collapsedKeys, outline, query]);

  const hasAnyCollapsible = useMemo(() => {
    return outline.some((_, idx) => childCountFor(outline, idx) > 0);
  }, [outline]);

  const toggleFold = (item: NumberedOutlineItem) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      const key = outlineKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (collapsed) {
    return (
      <section className="typeset-outline-collapsed" aria-label={copy.documentOutlineLabel}>
        <button type="button" onClick={onToggleCollapsed}>
          <ToolIcon name="list" />
          <span>{copy.outline}</span>
          <em>{outline.length}</em>
        </button>
      </section>
    );
  }

  const flexBasis = height == null ? "33.333%" : `${height}px`;
  const panelStyle = { flexBasis, flexShrink: height == null ? 1 : 0 };
  const resizeHandle = (
    <div
      className="typeset-outline-resize"
      role="separator"
      aria-label={copy.resizeLabel}
      aria-orientation="horizontal"
      aria-valuemin={OUTLINE_PANEL_MIN_H}
      aria-valuemax={OUTLINE_PANEL_MAX_H}
      aria-valuenow={height ?? undefined}
      aria-valuetext={height == null ? copy.resizeThirdHeight : copy.resizePixels(height)}
      title={copy.resizeTitle}
      tabIndex={0}
      onKeyDown={onResizeKeyDown}
      onPointerDown={onResizePointerDown}
    >
      <span className="typeset-outline-resize-handle" aria-hidden="true">
        <i className="typeset-outline-resize-dot" />
        <i className="typeset-outline-resize-dot" />
        <i className="typeset-outline-resize-dot" />
        <i className="typeset-outline-resize-dot" />
      </span>
    </div>
  );

  const head = (
    <div className="typeset-outline-head">
      <button
        type="button"
        className="typeset-outline-title-btn"
        title={copy.hideOutline}
        onClick={onToggleCollapsed}
      >
        <ToolIcon name="chevron" className="typeset-outline-head-chevron" />
        <strong>{copy.outline}</strong>
        {outline.length > 0 && <span className="typeset-outline-badge">{outline.length}</span>}
      </button>
      <button type="button" className="typeset-outline-toggle" title={copy.hideOutline} aria-label={copy.hideOutline} onClick={onToggleCollapsed}>
        <ToolIcon name="clear" />
      </button>
    </div>
  );

  if (outline.length === 0) {
    return (
      <>
        {resizeHandle}
        <section className="typeset-outline empty" aria-label={copy.documentOutlineLabel} style={panelStyle}>
          {head}
          <span className="typeset-outline-empty">{copy.notFoundSections}</span>
        </section>
      </>
    );
  }

  return (
    <>
      {resizeHandle}
      <section className="typeset-outline" aria-label={copy.documentOutlineLabel} style={panelStyle}>
        {head}
        <div className="typeset-outline-filter">
          <ToolIcon name="search" />
          <input
            type="search"
            value={filter}
            placeholder={copy.filterPlaceholder}
            aria-label={copy.filterLabel}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="typeset-outline-list">
          {visible.map(({ item, index }) => {
            const included = item.file != null && !sameWorkspacePath(item.file, currentPath);
            const active = !included && activeLine === item.line;
            const children = query ? 0 : childCountFor(outline, index);
            const folded = collapsedKeys.has(outlineKey(item));
            return (
              <div
                key={outlineKey(item)}
                className="typeset-outline-row"
                data-level={Math.min(item.level, 4)}
                // Indent the row, not the label, so the fold arrow lines up
                // with the heading it belongs to.
                style={{ marginLeft: `${(item.level - 1) * 8}px` }}
              >
                {children > 0 ? (
                  <button
                    type="button"
                    className={`typeset-outline-fold${folded ? " folded" : ""}`}
                    aria-expanded={!folded}
                    aria-label={folded ? copy.expandSection : copy.collapseSection}
                    title={folded ? copy.expandSection : copy.collapseSection}
                    onClick={() => toggleFold(item)}
                  >
                    <ToolIcon name="chevron" />
                  </button>
                ) : hasAnyCollapsible && item.level === 1 ? (
                  <span className="typeset-outline-fold-spacer" />
                ) : null}
                <button
                  type="button"
                  className={`typeset-outline-item${active ? " active" : ""}`}
                  aria-current={active ? "location" : undefined}
                  data-level={Math.min(item.level, 4)}
                  // An included heading opens another file, so say which one rather
                  // than showing a line number that belongs to a different document.
                  title={included ? copy.includedIn(basename(item.file ?? ""), item.line) : item.title}
                  onClick={() => onJumpToLine(item.line, item.file)}
                >
                  {item.number ? <b>{item.number}</b> : null}
                  <span className="typeset-outline-title">{item.title}</span>
                  {included ? <i className="typeset-outline-file">{basename(item.file ?? "")}</i> : <em className="typeset-outline-line">{item.line}</em>}
                </button>
              </div>
            );
          })}
          {visible.length === 0 ? <span className="typeset-outline-empty">{copy.noMatches}</span> : null}
        </div>
        {wordCount != null ? (
          <div className="typeset-outline-foot" aria-live="off">{copy.words(wordCount)}</div>
        ) : null}
      </section>
    </>
  );
}
