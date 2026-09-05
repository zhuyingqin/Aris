/**
 * Symbol palette: the grid of maths symbols Overleaf keeps under its editor
 * (`extensions/symbol-palette.ts`). Each face is rendered with the same KaTeX
 * build the Visual editor uses, so what you click is what the PDF prints.
 */
import { useMemo, useState, type RefObject } from "react";
import katex from "katex";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { ToolIcon } from "./ToolIcon";
import { TypesetPopover } from "./TypesetPopover";
import { SYMBOL_GROUPS, filterSymbols, type LatexSymbolEntry } from "./symbolPalette";

function SymbolFace({ symbol }: { symbol: LatexSymbolEntry }) {
  const html = useMemo(() => {
    const source = symbol.preview ?? symbol.command;
    try {
      return katex.renderToString(source, { throwOnError: false, displayMode: false, output: "html" });
    } catch {
      // A face that will not render is still a usable button with its command.
      return "";
    }
  }, [symbol]);
  if (!html) return <span className="typeset-symbol-fallback">{symbol.command}</span>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function TypesetSymbolPalette({
  open,
  anchorRef,
  onClose,
  onInsert,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInsert: (symbol: LatexSymbolEntry) => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].symbolPalette;
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterSymbols(SYMBOL_GROUPS, query), [query]);

  return (
    <TypesetPopover
      open={open}
      anchorRef={anchorRef}
      align="start"
      width={430}
      maxHeight={420}
      className="typeset-symbol-palette"
      label={copy.title}
      onClose={onClose}
    >
      <div className="typeset-symbol-palette-head">
        <strong>{copy.title}</strong>
        <div className="typeset-symbol-palette-filter">
          <ToolIcon name="search" />
          <input
            type="search"
            value={query}
            aria-label={copy.filterLabel}
            placeholder={copy.filterPlaceholder}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <button type="button" title={copy.close} aria-label={copy.close} onClick={onClose}>
          <ToolIcon name="clear" />
        </button>
      </div>
      <div className="typeset-symbol-palette-body">
        {groups.map((group) => (
          <section key={group.id}>
            <h4>{copy.groupLabel(group.id)}</h4>
            <div className="typeset-symbol-grid">
              {group.symbols.map((symbol) => (
                <button
                  key={symbol.command}
                  type="button"
                  className="typeset-symbol-button"
                  title={symbol.command}
                  aria-label={symbol.command}
                  onClick={() => onInsert(symbol)}
                >
                  <SymbolFace symbol={symbol} />
                </button>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 ? <p className="typeset-symbol-empty">{copy.noMatches}</p> : null}
      </div>
    </TypesetPopover>
  );
}
