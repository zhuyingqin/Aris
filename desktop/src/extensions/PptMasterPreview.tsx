import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  fileAssetUrl,
  fileOpen,
  fileReveal,
  pptMasterDecksList,
} from "../api/tauri";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { PptMasterDeck } from "../types";
import "./PptMasterPreview.css";

const COPY = {
  cn: {
    title: "PPT Master 幻灯片预览",
    subtitle: "检查最终 SVG 页面，并从这里打开原生 PPTX。",
    decks: "演示文稿",
    noDecks: "还没有发现可预览的幻灯片",
    noDecksHint: "完成一次 PPT Master 生成后，svg_final/ 会自动出现在这里。",
    loading: "正在扫描幻灯片…",
    failed: (reason: string) => `无法读取幻灯片：${reason}`,
    refresh: "刷新",
    close: "关闭预览",
    previous: "上一页",
    next: "下一页",
    openPptx: "用系统程序打开 PPTX",
    reveal: "在资源管理器中显示",
    slideCount: (count: number) => `${count} 页`,
    page: (page: number, total: number) => `第 ${page} / ${total} 页`,
    keyboardHint: "← → 翻页 · Esc 关闭",
    noExport: "尚未导出 PPTX",
  },
  en: {
    title: "PPT Master slide preview",
    subtitle: "Review final SVG slides and open the native PPTX from here.",
    decks: "Presentations",
    noDecks: "No previewable slides yet",
    noDecksHint: "After a PPT Master run completes, its svg_final/ folder appears here automatically.",
    loading: "Scanning slides…",
    failed: (reason: string) => `Could not read slides: ${reason}`,
    refresh: "Refresh",
    close: "Close preview",
    previous: "Previous slide",
    next: "Next slide",
    openPptx: "Open PPTX with system app",
    reveal: "Show in file manager",
    slideCount: (count: number) => `${count} slides`,
    page: (page: number, total: number) => `Slide ${page} of ${total}`,
    keyboardHint: "← → change slide · Esc closes",
    noExport: "PPTX has not been exported yet",
  },
} as const;

function SlideImage({ path, alt, className }: { path: string; alt: string; className: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void fileAssetUrl(path, "image/svg+xml")
      .then((next) => {
        objectUrl = next.startsWith("blob:") ? next : null;
        if (disposed) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        } else {
          setUrl(next);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) return <span className={`${className} ppt-preview-image-error`}>SVG</span>;
  if (!url) return <span className={`${className} ppt-preview-image-loading`} />;
  return <img className={className} src={url} alt={alt} draggable={false} />;
}

export default function PptMasterPreview({ onClose }: { onClose: () => void }) {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const copy = COPY[language];
  const [decks, setDecks] = useState<PptMasterDeck[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await pptMasterDecksList();
      setDecks(next);
      setSelectedDeckId((current) => (
        current && next.some((deck) => deck.id === current) ? current : next[0]?.id ?? null
      ));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [currentProject?.id, refresh]);

  const selectedDeck = useMemo(
    () => decks.find((deck) => deck.id === selectedDeckId) ?? decks[0] ?? null,
    [decks, selectedDeckId],
  );
  const selectedSlide = selectedDeck?.slides[slideIndex] ?? null;

  useEffect(() => {
    setSlideIndex(0);
  }, [selectedDeck?.id]);

  useEffect(() => {
    setSlideIndex((current) => Math.min(current, Math.max(0, (selectedDeck?.slides.length ?? 1) - 1)));
  }, [selectedDeck?.slides.length]);

  const step = useCallback((direction: number) => {
    if (!selectedDeck) return;
    setSlideIndex((current) => Math.max(0, Math.min(selectedDeck.slides.length - 1, current + direction)));
  }, [selectedDeck]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        step(1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSlideIndex(0);
      } else if (event.key === "End" && selectedDeck) {
        event.preventDefault();
        setSlideIndex(Math.max(0, selectedDeck.slides.length - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, selectedDeck, step]);

  const preview = (
    <div className="ppt-preview-overlay" role="dialog" aria-modal="true" aria-label={copy.title}>
      <header className="ppt-preview-header">
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <div className="ppt-preview-header-actions">
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={copy.refresh}>
            <SvgIcon name={loading ? "spinner" : "refresh"} size={15} />
            {copy.refresh}
          </button>
          <button type="button" onClick={onClose} aria-label={copy.close}>
            <SvgIcon name="close" size={17} />
          </button>
        </div>
      </header>

      <div className="ppt-preview-body">
        <aside className="ppt-preview-decks" aria-label={copy.decks}>
          <strong>{copy.decks}</strong>
          {decks.map((deck) => (
            <button
              type="button"
              key={deck.id}
              className={deck.id === selectedDeck?.id ? "active" : ""}
              onClick={() => setSelectedDeckId(deck.id)}
            >
              <SvgIcon name="document" size={16} />
              <span>
                <b>{deck.title}</b>
                <em>{copy.slideCount(deck.slides.length)}</em>
              </span>
            </button>
          ))}
        </aside>

        {loading && decks.length === 0 ? (
          <div className="ppt-preview-state"><SvgIcon name="spinner" size={20} />{copy.loading}</div>
        ) : error ? (
          <div className="ppt-preview-state error">{copy.failed(error)}</div>
        ) : !selectedDeck || !selectedSlide ? (
          <div className="ppt-preview-state">
            <SvgIcon name="image" size={28} />
            <strong>{copy.noDecks}</strong>
            <span>{copy.noDecksHint}</span>
          </div>
        ) : (
          <>
            <nav className="ppt-preview-thumbnails" aria-label={copy.page(slideIndex + 1, selectedDeck.slides.length)}>
              {selectedDeck.slides.map((slide, index) => (
                <button
                  type="button"
                  key={slide.path}
                  className={index === slideIndex ? "active" : ""}
                  onClick={() => setSlideIndex(index)}
                  aria-label={copy.page(index + 1, selectedDeck.slides.length)}
                  aria-current={index === slideIndex ? "page" : undefined}
                >
                  <SlideImage path={slide.path} alt="" className="ppt-preview-thumb-image" />
                  <span>{index + 1}</span>
                </button>
              ))}
            </nav>

            <main className="ppt-preview-canvas">
              <div className="ppt-preview-stage">
                <SlideImage
                  path={selectedSlide.path}
                  alt={copy.page(slideIndex + 1, selectedDeck.slides.length)}
                  className="ppt-preview-main-image"
                />
              </div>
              <footer className="ppt-preview-toolbar">
                <button type="button" onClick={() => step(-1)} disabled={slideIndex === 0} aria-label={copy.previous}>
                  <SvgIcon name="chevronLeft" size={17} />
                </button>
                <span>{copy.page(slideIndex + 1, selectedDeck.slides.length)}</span>
                <button
                  type="button"
                  onClick={() => step(1)}
                  disabled={slideIndex >= selectedDeck.slides.length - 1}
                  aria-label={copy.next}
                >
                  <SvgIcon name="chevronRight" size={17} />
                </button>
                <i>{copy.keyboardHint}</i>
                <button type="button" onClick={() => void fileReveal(selectedDeck.rootPath)} title={selectedDeck.rootPath}>
                  <SvgIcon name="folder" size={15} />
                  {copy.reveal}
                </button>
                {selectedDeck.exportPath ? (
                  <button type="button" className="primary" onClick={() => void fileOpen(selectedDeck.exportPath!)}>
                    <SvgIcon name="externalLink" size={15} />
                    {copy.openPptx}
                  </button>
                ) : (
                  <span className="ppt-preview-no-export">{copy.noExport}</span>
                )}
              </footer>
            </main>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(preview, document.body);
}
