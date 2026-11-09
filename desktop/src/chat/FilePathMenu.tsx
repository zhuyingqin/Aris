import { useEffect, useRef, useState } from "react";
import { fileOpen, fileRead } from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import { workspaceFileOpenTarget } from "../editor/workspaceFiles";
import { isImagePath } from "../imageFiles";
import { copyImageToClipboard } from "../imageClipboard";
import { useStore } from "../store";

interface Props {
  x: number;
  y: number;
  path: string;
  image?: boolean;
  projectRoot?: string;
  onClose: () => void;
  onAttach: (path: string, content: string) => void;
  onOpenInWorkspace: (path: string) => void;
  /** Open the file as a reading tab in the chat side panel. */
  onOpenInSidePanel?: (path: string) => void;
}

export default function FilePathMenu({
  x,
  y,
  path,
  image = false,
  projectRoot,
  onClose,
  onAttach,
  onOpenInWorkspace,
  onOpenInSidePanel,
}: Props) {
  const language = useStore((state) => state.language);
  const [openInOpen, setOpenInOpen] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [copyImageError, setCopyImageError] = useState(false);
  const [pos, setPos] = useState({ x, y });
  const menuRef = useRef<HTMLDivElement>(null);

  const filename = path.split(/[\\/]/).pop() ?? path;
  const relativePath =
    projectRoot && path.startsWith(projectRoot)
      ? path.slice(projectRoot.length).replace(/^[\\/]/, "")
      : path;
  const parentDir = path.includes("/")
    ? path.substring(0, path.lastIndexOf("/"))
    : path.includes("\\")
      ? path.substring(0, path.lastIndexOf("\\"))
      : ".";
  const workspaceTarget = workspaceFileOpenTarget(path);
  // PDFs are covered by the side-panel reader below, so only editable sources
  // offer a workspace tab here.
  const workspaceOpenLabel = workspaceTarget === "code" ? "在 Code 页面打开" : "在 LaTeX 页面打开";

  // Clamp to viewport after first paint
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw) nx = vw - rect.width - 8;
    if (ny + rect.height > vh) ny = vh - rect.height - 8;
    if (nx < 0) nx = 4;
    if (ny < 0) ny = 4;
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  // Close on outside click (delay so the triggering right-click doesn't immediately close)
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      const handler = (e: MouseEvent) => {
        if (!menuRef.current?.contains(e.target as Node)) onClose();
      };
      document.addEventListener("mousedown", handler);
      cleanup = () => document.removeEventListener("mousedown", handler);
    }, 60);
    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // A menu above the image viewer owns Escape until it closes.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    onClose();
  };

  const handleAttach = async () => {
    onClose();
    try {
      const content = await fileRead(path, 500);
      onAttach(path, content);
    } catch {
      onAttach(path, "");
    }
  };

  const handleCopyImage = async () => {
    if (copyingImage) return;
    setCopyingImage(true);
    setCopyImageError(false);
    try {
      await copyImageToClipboard(path);
      onClose();
    } catch {
      setCopyImageError(true);
    } finally {
      setCopyingImage(false);
    }
  };

  return (
    <div
      ref={menuRef}
      className="file-path-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="File options"
    >
      {(image || isImagePath(path)) && (
        <>
          <button role="menuitem" disabled={copyingImage} onClick={() => void handleCopyImage()}>
            {language === "cn"
              ? copyingImage ? "正在复制图片…" : "复制图片"
              : copyingImage ? "Copying image…" : "Copy image"}
          </button>
          {copyImageError && (
            <div className="file-path-menu-error" role="alert">
              {language === "cn" ? "图片复制失败，请重试。" : "Could not copy image. Try again."}
            </div>
          )}
          <div className="file-path-menu-divider" />
        </>
      )}
      <button role="menuitem" onClick={() => void handleAttach()}>
        附加为上下文
      </button>
      <div className="file-path-menu-divider" />
      <button role="menuitem" onClick={() => copy(path)}>
        复制路径
      </button>
      <button role="menuitem" onClick={() => copy(relativePath)}>
        复制相对路径
      </button>
      <button role="menuitem" onClick={() => copy(filename)}>
        复制文件名
      </button>
      <div className="file-path-menu-divider" />
      {onOpenInSidePanel && (
        <button role="menuitem" onClick={() => { onOpenInSidePanel(path); onClose(); }}>
          在侧栏阅读
        </button>
      )}
      {(workspaceTarget === "code" || workspaceTarget === "latex") && (
        <button role="menuitem" onClick={() => { onOpenInWorkspace(path); onClose(); }}>
          {workspaceOpenLabel}
        </button>
      )}
      <div
        className={`file-path-menu-has-sub${openInOpen ? " open" : ""}`}
        onMouseEnter={() => setOpenInOpen(true)}
        onMouseLeave={() => setOpenInOpen(false)}
      >
        <button role="menuitem">
          在...中打开
          <span className="file-path-menu-arrow"><SvgIcon name="chevronRight" size={12} /></span>
        </button>
        {openInOpen && (
          <div className="file-path-menu-sub" role="menu">
            <button
              role="menuitem"
              onClick={() => { void fileOpen(path); onClose(); }}
            >
              打开文件
            </button>
            <button
              role="menuitem"
              onClick={() => { void fileOpen(parentDir); onClose(); }}
            >
              在资源管理器中显示
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
