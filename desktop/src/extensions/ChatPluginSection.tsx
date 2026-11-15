import { useId, useState, type ReactNode } from "react";
import { SvgIcon, type SvgIconName } from "../SvgIcon";

// Adapted from DeepSeek Harness TodoPanel / DisclosureRow at fcc0ad4 (MIT).
// Keep the compact icon/title/summary disclosure, with SomniQ tokens and a
// native button. Hidden bodies stay mounted so folding never discards a draft.
export function WidgetSection({ title, icon, summary, preview, attention, children }: {
  title: string; icon: SvgIconName; summary?: string; preview?: string; attention?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return <section className="chat-plugin-widget" aria-label={title}>
    <h3 className="chat-plugin-widget-heading">
      <button type="button" className="chat-plugin-disclosure" aria-label={title} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
        <SvgIcon name={icon} size={15} className="chat-plugin-widget-icon" />
        <span className="chat-plugin-widget-title">{title}</span>
        {summary && <span className={`chat-plugin-summary${attention ? " has-changes" : ""}`}>{summary}</span>}
        <SvgIcon name={open ? "chevronDown" : "chevronRight"} size={12} className="chat-plugin-chevron" />
      </button>
    </h3>
    {!open && preview && <p className="chat-plugin-plan-summary">{preview}</p>}
    <div id={bodyId} className="chat-plugin-widget-body" hidden={!open}>{children}</div>
  </section>;
}
