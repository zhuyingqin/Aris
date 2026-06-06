import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChatCommandSelection } from "../types";

interface Props {
  selection: ChatCommandSelection;
  bottomOffset: number;
  onSelect: (value: string) => void;
  onCancel: () => void;
}

function initialIndex(selection: ChatCommandSelection): number {
  const current = selection.items.findIndex((item) => item.isCurrent);
  return current >= 0 ? current : 0;
}

export default function CommandSelection({
  selection,
  bottomOffset,
  onSelect,
  onCancel,
}: Props) {
  const [activeIndex, setActiveIndex] = useState(() => initialIndex(selection));
  const listboxId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setActiveIndex(initialIndex(selection));
  }, [selection]);

  useEffect(() => {
    scrollRef.current?.focus();
  }, [selection]);

  useLayoutEffect(() => {
    const active = activeRef.current;
    const scroller = scrollRef.current;
    if (!active || !scroller) return;

    const activeTop = active.offsetTop;
    const activeBottom = activeTop + active.offsetHeight;
    const visibleTop = scroller.scrollTop;
    const visibleBottom = visibleTop + scroller.clientHeight;
    if (activeTop < visibleTop) {
      scroller.scrollTop = activeTop;
    } else if (activeBottom > visibleBottom) {
      scroller.scrollTop = activeBottom - scroller.clientHeight;
    }
    active.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeIndex, selection]);

  const choose = (index: number) => {
    const item = selection.items[index];
    if (item) onSelect(item.value);
  };

  const maxIndex = Math.max(selection.items.length - 1, 0);

  return (
    <div
      className="command-select"
      style={{
        bottom: `${bottomOffset}px`,
        maxHeight: `min(440px, calc(100% - ${bottomOffset + 12}px))`,
      }}
      role="dialog"
      aria-modal="false"
      aria-label={selection.title}
    >
      <div className="command-select-head">
        <div>
          <div className="command-select-title">{selection.title}</div>
          {selection.subtitle && <div className="command-select-subtitle">{selection.subtitle}</div>}
        </div>
        <button className="command-select-close" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
          Esc
        </button>
      </div>
      <div
        className="command-select-scroll"
        role="listbox"
        tabIndex={0}
        ref={scrollRef}
        aria-activedescendant={selection.items.length ? `${listboxId}-option-${activeIndex}` : undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, maxIndex));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            choose(activeIndex);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        {selection.items.map((item, index) => (
          <div
            key={item.value}
            id={`${listboxId}-option-${index}`}
            className={`command-select-item${index === activeIndex ? " active" : ""}`}
            role="option"
            aria-selected={index === activeIndex}
            ref={index === activeIndex ? activeRef : undefined}
            onMouseMove={() => setActiveIndex(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(index);
            }}
          >
            <span className="command-select-label">{item.label}</span>
            <span className="command-select-desc">{item.description}</span>
            {item.isCurrent && <span className="command-select-current">Current</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
