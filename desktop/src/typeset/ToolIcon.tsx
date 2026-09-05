/**
 * The inline SVG set the Typeset workbench uses for toolbar and rail buttons.
 * Lives on its own so the panels split out of `Typeset.tsx` can draw icons
 * without importing the workbench.
 */

export function ToolIcon({ name, className }: { name: "compile" | "save" | "refresh" | "new" | "open" | "minus" | "plus" | "code" | "visual" | "presentation" | "logs" | "files" | "search" | "history" | "settings" | "download" | "home" | "undo" | "redo" | "list" | "figure" | "table" | "citation" | "clear" | "copy" | "review" | "previous" | "next" | "comments" | "link" | "ref" | "chevron" | "numberedList" | "contrast" | "syncToPdf" | "syncToCode" | "more" | "ai"; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none">
      {name === "compile" && <path d="M5.2 3.1 12 8l-6.8 4.9z" fill="currentColor" />}
      {name === "save" && (
        <path d="M3 3h8.5L13 4.5V13H3zM5 3v3.2h5.2V3M5.2 10.2h5.6" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      )}
      {name === "refresh" && (
        <path d="M12.6 5.5A5 5 0 1 0 13 8M12.6 2.8v2.7h-2.7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "new" && (
        <path d="M4 2.7h5.2L12 5.5v7.8H4zM9.2 2.7v2.8H12M8 7.3v4M6 9.3h4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "open" && (
        <path d="M5.5 3.2H3.4A1.4 1.4 0 0 0 2 4.6v8A1.4 1.4 0 0 0 3.4 14h8a1.4 1.4 0 0 0 1.4-1.4v-2.1M8.2 2H14v5.8M7.8 8.2 14 2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "minus" && <path d="M4 8h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {name === "plus" && <path d="M8 3.8v8.4M3.8 8h8.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {name === "code" && <path d="m6.3 4-3.5 4 3.5 4M9.7 4l3.5 4-3.5 4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "visual" && <path d="M2.5 8s2-3.6 5.5-3.6S13.5 8 13.5 8s-2 3.6-5.5 3.6S2.5 8 2.5 8zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "presentation" && (
        <path
          d="M2 2.8h12M3.2 2.8v6.6a.8.8 0 0 0 .8.8h8a.8.8 0 0 0 .8-.8V2.8M5.2 13.8l2.8-3.6 2.8 3.6"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {name === "logs" && <path d="M3.2 3.2h9.6v9.6H3.2zM5.2 5.6h5.6M5.2 8h5.6M5.2 10.4h3.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "files" && <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12M5.8 8h4.4M5.8 10.2h4.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "search" && <path d="M7.2 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2zM10.2 10.2 13 13" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "history" && <path d="M4.1 5.1A4.8 4.8 0 1 1 3.3 8M4.1 5.1H2.2V3.2M8 5.4v3l2 1.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "settings" && (
        <>
          <circle cx="8" cy="8" r="2.3" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M7.1 1.8h1.8l.3 1.2a4.8 4.8 0 0 1 1.2.7l1.1-.6 1.3 1.3-.6 1.1c.3.4.5.8.7 1.2l1.2.3v1.8l-1.2.3a4.8 4.8 0 0 1-.7 1.2l.6 1.1-1.3 1.3-1.1-.6a4.8 4.8 0 0 1-1.2.7l-.3 1.2H7.1l-.3-1.2a4.8 4.8 0 0 1-1.2-.7l-1.1.6-1.3-1.3.6-1.1a4.8 4.8 0 0 1-.7-1.2l-1.2-.3V7.1l1.2-.3a4.8 4.8 0 0 1 .7-1.2l-.6-1.1 1.3-1.3 1.1.6a4.8 4.8 0 0 1 1.2-.7l.3-1.2z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </>
      )}
      {name === "download" && <path d="M8 2.8v6.4M5.4 6.8 8 9.4l2.6-2.6M3.2 12.8h9.6" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "home" && <path d="M2.7 7.3 8 3l5.3 4.3M4.2 6.4v6.1h7.6V6.4M6.7 12.5V9.2h2.6v3.3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "undo" && <path d="M6.8 4.1 3.4 7.5l3.4 3.4M3.8 7.5h5.5a3.4 3.4 0 0 1 0 6.8H7.4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "redo" && <path d="m9.2 4.1 3.4 3.4-3.4 3.4M12.2 7.5H6.7a3.4 3.4 0 0 0 0 6.8h1.9" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "list" && <path d="M5.7 4.5h7M5.7 8h7M5.7 11.5h7M3.2 4.5h.1M3.2 8h.1M3.2 11.5h.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "figure" && <path d="M2.8 3.2h10.4v9.6H2.8zM4.6 10.8l2.6-3 1.9 2.1 1.1-1.2 1.4 2.1M5.4 5.6h.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "table" && <path d="M2.8 3.2h10.4v9.6H2.8zM2.8 6.4h10.4M2.8 9.6h10.4M6.25 3.2v9.6M9.75 3.2v9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "citation" && <path d="M5.2 5.2H3.5v5.6h3.1V7.9H5.1c0-1.5.7-2.7 2.1-3.6M11.1 5.2H9.4v5.6h3.1V7.9H11c0-1.5.7-2.7 2.1-3.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "clear" && <path d="M4.1 4.1 11.9 12M11.9 4.1 4.1 12" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "copy" && <path d="M6 5.9h6.3v6.4H6zM10.1 5.9V3.7H3.8v6.4H6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "review" && (
        <>
          <path
            d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="m5.8 9 1.6 1.6 3.4-3.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {name === "ai" && (
        <>
          <path
            d="M7.8 2.2l1 3.2 3.2 1-3.2 1-1 3.2-1-3.2-3.2-1 3.2-1 1-3.2z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <path
            d="M12.5 1.8l.4 1.2 1.2.4-1.2.4-.4 1.2-.4-1.2-1.2-.4 1.2-.4.4-1.2z"
            fill="currentColor"
          />
          <path
            d="M2.8 13.6h10.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )}
      {name === "previous" && <path d="M10 4 6 8l4 4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "next" && <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "comments" && <path d="M3 3.5h10v7H7.2L4.2 13v-2.5H3zM5.3 6.1h5.4M5.3 8h3.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "link" && <path d="M9 5.4 10 4.4a2.6 2.6 0 0 1 3.7 3.7l-1.6 1.6a2.6 2.6 0 0 1-3.7 0M7 10.6l-1 1a2.6 2.6 0 0 1-3.7-3.7l1.6-1.6a2.6 2.6 0 0 1 3.7 0M6.2 9.8l3.6-3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "ref" && <path d="M8.7 2.9H12.5a.7.7 0 0 1 .7.7v3.8L7.7 12.6a1 1 0 0 1-1.4 0L3.1 9.4a1 1 0 0 1 0-1.4L8.7 2.9zM10.7 5.3h.01" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "contrast" && (
        <>
          <path d="M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8z" stroke="currentColor" strokeWidth="1.35" />
          <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" />
        </>
      )}
      {name === "syncToPdf" && <path d="M3.2 8h9.6M9.2 4.4 12.8 8l-3.6 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "syncToCode" && <path d="M12.8 8H3.2M6.8 4.4 3.2 8l3.6 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "chevron" && <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "more" && <path d="M3.6 8h.01M8 8h.01M12.4 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
      {name === "numberedList" && <path d="M6.2 4.5h6.8M6.2 8h6.8M6.2 11.5h6.8M2.6 3.2h.8v2.4M2.4 5.6h1.6M2.5 7.6a.7.7 0 0 1 1.2.5c0 .6-1.2.9-1.2 1.6h1.4M2.5 10.2a.65.65 0 1 1 .9.6.65.65 0 0 1-.9.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
