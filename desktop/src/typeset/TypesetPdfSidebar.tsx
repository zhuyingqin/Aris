import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { tr, type Language } from "../language";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { activeOutlinePath, pdfOutlineEntries, type PdfOutlineEntry } from "./pdfOutline";

export type PdfSidebarTab = "outline" | "thumbnails";

const THUMBNAIL_WIDTH = 132;
/** A thumbnail is small; this keeps hundreds of them from holding real memory. */
const THUMBNAIL_MAX_PIXELS = 260_000;

/**
 * Thumbnails render one after another, never all at once: opening the panel on
 * a 300-page thesis must not stall the page the reader is looking at.
 */
function createRenderQueue() {
  let tail: Promise<void> = Promise.resolve();
  return (job: () => Promise<void>) => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

function PdfThumbnail({
  pdf,
  page,
  size,
  active,
  rootRef,
  enqueue,
  label,
  onSelect,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  size: { width: number; height: number };
  active: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  enqueue: (job: () => Promise<void>) => Promise<void>;
  label: string;
  onSelect: (page: number) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined" && page <= 12);
  const height = Math.round(THUMBNAIL_WIDTH * (size.height / Math.max(1, size.width)));

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      // Far enough ahead that scrolling meets rendered pages, near enough that
      // pages scrolled past give their canvases back.
      { root: rootRef.current, rootMargin: "500px 0px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [rootRef]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void enqueue(async () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pdfPage = await pdf.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const render = renderPdfPageToCanvas(pdfPage, canvas, THUMBNAIL_WIDTH / Math.max(1, base.width), {
        maxPixels: THUMBNAIL_MAX_PIXELS,
      });
      task = render.task;
      await render.task.promise;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [enqueue, page, pdf, visible]);

  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`typeset-pdf-thumbnail${active ? " active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(page)}
    >
      <span className="typeset-pdf-thumbnail-sheet" style={{ width: THUMBNAIL_WIDTH, height }}>
        <canvas ref={canvasRef} aria-hidden="true" />
      </span>
      <span className="typeset-pdf-thumbnail-number">{page}</span>
    </button>
  );
}

function OutlineTree({
  entries,
  expanded,
  activePath,
  toggleLabel,
  onToggle,
  onSelect,
}: {
  entries: PdfOutlineEntry[];
  expanded: Set<string>;
  activePath: string[];
  toggleLabel: (open: boolean, title: string) => string;
  onToggle: (id: string) => void;
  onSelect: (page: number) => void;
}) {
  const activeId = activePath[activePath.length - 1];
  return (
    <ul role="group">
      {entries.map((entry) => {
        const open = expanded.has(entry.id);
        const hasChildren = entry.children.length > 0;
        const isActive = entry.id === activeId;
        // A collapsed chapter still shows that the reader is inside it.
        const containsActive = !isActive && !open && activePath.includes(entry.id);
        return (
          <li key={entry.id} role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={isActive}>
            <div
              className={`typeset-pdf-outline-row${isActive ? " active" : ""}${containsActive ? " contains-active" : ""}`}
              style={{ paddingLeft: 4 + entry.depth * 12 }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="typeset-pdf-outline-twisty"
                  aria-label={toggleLabel(open, entry.title)}
                  onClick={() => onToggle(entry.id)}
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
              ) : <span className="typeset-pdf-outline-twisty" aria-hidden="true" />}
              <button
                type="button"
                className="typeset-pdf-outline-title"
                disabled={entry.page == null}
                title={entry.title}
                style={{ fontWeight: entry.bold ? 600 : undefined, fontStyle: entry.italic ? "italic" : undefined }}
                onClick={() => entry.page != null && onSelect(entry.page)}
              >
                <span>{entry.title}</span>
                {entry.page != null && <em>{entry.page}</em>}
              </button>
            </div>
            {hasChildren && open && (
              <OutlineTree entries={entry.children} expanded={expanded} activePath={activePath} toggleLabel={toggleLabel} onToggle={onToggle} onSelect={onSelect} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Bookmarks and page thumbnails beside the PDF. */
export default function TypesetPdfSidebar({
  pdf,
  numPages,
  currentPage,
  pageSizes,
  language,
  tab,
  onTabChange,
  onNavigate,
}: {
  pdf: PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  pageSizes: Record<number, { width: number; height: number }>;
  language: Language;
  /** null: bookmarks when the PDF has any, thumbnails otherwise. */
  tab: PdfSidebarTab | null;
  onTabChange: (tab: PdfSidebarTab) => void;
  onNavigate: (page: number) => void;
}) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const [outline, setOutline] = useState<PdfOutlineEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seenIdsRef = useRef(new Set<string>());
  const thumbnailsRef = useRef<HTMLDivElement | null>(null);
  const enqueue = useMemo(() => createRenderQueue(), [pdf]);

  useEffect(() => {
    if (!pdf) {
      setOutline(null);
      return;
    }
    let active = true;
    void pdfOutlineEntries(pdf)
      .then((entries) => {
        if (!active) return;
        setOutline(entries);
        // Chapters open the first time they appear; after a recompile the
        // reader's own collapsing and expanding is kept.
        setExpanded((current) => {
          const next = new Set(current);
          for (const entry of entries) {
            if (!seenIdsRef.current.has(entry.id)) next.add(entry.id);
            seenIdsRef.current.add(entry.id);
          }
          return next;
        });
      })
      .catch(() => {
        if (active) setOutline([]);
      });
    return () => {
      active = false;
    };
  }, [pdf]);

  const activePath = useMemo(() => activeOutlinePath(outline ?? [], currentPage), [currentPage, outline]);
  const shownTab: PdfSidebarTab = tab ?? (outline && outline.length === 0 ? "thumbnails" : "outline");
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <aside className="typeset-pdf-sidebar" aria-label={t("PDF 书签和缩略图", "PDF bookmarks and thumbnails", "Marcadores y miniaturas del PDF")}>
      <div className="typeset-pdf-sidebar-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={shownTab === "outline"} onClick={() => onTabChange("outline")}>
          {t("书签", "Bookmarks", "Marcadores")}
        </button>
        <button type="button" role="tab" aria-selected={shownTab === "thumbnails"} onClick={() => onTabChange("thumbnails")}>
          {t("缩略图", "Thumbnails", "Miniaturas")}
        </button>
      </div>
      {shownTab === "outline" ? (
        <div className="typeset-pdf-outline" role="tree" aria-label={t("书签", "Bookmarks", "Marcadores")}>
          {outline === null ? (
            <p className="typeset-pdf-sidebar-note">{t("正在读取书签…", "Reading bookmarks…", "Leyendo marcadores…")}</p>
          ) : outline.length === 0 ? (
            <p className="typeset-pdf-sidebar-note">{t(
              "这个 PDF 没有书签。在导言区加入 \\usepackage{hyperref}，章节标题就会生成书签。",
              "This PDF has no bookmarks. Add \\usepackage{hyperref} to the preamble and section titles become bookmarks.",
              "Este PDF no tiene marcadores. Añade \\usepackage{hyperref} al preámbulo y los títulos de sección se convertirán en marcadores.",
            )}</p>
          ) : (
            <OutlineTree
              entries={outline}
              expanded={expanded}
              activePath={activePath}
              toggleLabel={(open, title) => open
                ? t(`折叠“${title}”`, `Collapse "${title}"`, `Contraer «${title}»`)
                : t(`展开“${title}”`, `Expand "${title}"`, `Expandir «${title}»`)}
              onToggle={toggle}
              onSelect={onNavigate}
            />
          )}
        </div>
      ) : (
        <div className="typeset-pdf-thumbnails" ref={thumbnailsRef} role="list">
          {pdf && Array.from({ length: numPages }, (_, index) => {
            const page = index + 1;
            return (
              <PdfThumbnail
                key={page}
                pdf={pdf}
                page={page}
                size={pageSizes[page] ?? pageSizes[1] ?? { width: 612, height: 792 }}
                active={page === currentPage}
                rootRef={thumbnailsRef}
                enqueue={enqueue}
                label={t(`第 ${page} 页`, `Page ${page}`, `Página ${page}`)}
                onSelect={onNavigate}
              />
            );
          })}
        </div>
      )}
    </aside>
  );
}
