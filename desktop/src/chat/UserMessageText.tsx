import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { useDisclosure } from "./disclosureState";
import { CHAT_COPY } from "./i18n";
import { USER_MESSAGE_PREVIEW_LINES } from "./userMessageCollapse";

export default function UserMessageText({ text, disclosureKey }: { text: string; disclosureKey: string }) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const [expanded, setExpanded] = useDisclosure(disclosureKey);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(content).lineHeight);
      setOverflowing(content.getBoundingClientRect().height > lineHeight * USER_MESSAGE_PREVIEW_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    // Measure the full content inside the clipped viewport, including after
    // width or font changes, so opening it never removes its collapse button.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      className="chat-text chat-user-text"
      style={{ "--chat-user-preview-lines": USER_MESSAGE_PREVIEW_LINES } as CSSProperties}
    >
      <div id={contentId} className={`chat-user-text-viewport${expanded ? "" : " is-collapsed"}`}>
        <div ref={contentRef}>{text}</div>
      </div>
      {overflowing && (
        <button
          type="button"
          className="chat-user-text-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? copy.collapseMessage : copy.expandMessage}
          <SvgIcon name={expanded ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      )}
    </div>
  );
}
