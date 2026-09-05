import type { ReactNode } from "react";

type Props = {
  id: string;
  kicker: string;
  title: string;
  lede?: string;
  children: ReactNode;
  align?: "left" | "center";
  tone?: "default" | "raised";
};

export default function Section({
  id,
  kicker,
  title,
  lede,
  children,
  align = "left",
  tone = "default",
}: Props) {
  return (
    <section id={id} className={`section section--${tone}`}>
      {/* One container for head and body: the head must not carry `.container`
          itself, or its narrower `max-width` combines with `margin: 0 auto` and
          centres the heading instead of aligning it with the content below. */}
      <div className="container">
        <div className={`section-head section-head--${align}`} data-reveal>
          <p className="kicker">{kicker}</p>
          <h2 className="section-title">{title}</h2>
          {lede ? <p className="section-lede">{lede}</p> : null}
        </div>

        {children}
      </div>
    </section>
  );
}
