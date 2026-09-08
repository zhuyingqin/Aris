import type { Copy } from "../i18n";

type Props = { copy: Copy };

export default function Vision({ copy }: Props) {
  const { vision } = copy;

  return (
    <section id="vision" className="section vision">
      <div className="container vision-inner" data-reveal>
        <p className="kicker">{vision.kicker}</p>
        <h2 className="vision-title">{vision.title}</h2>
        <p className="vision-lede">{vision.lede}</p>

        <div className="vision-status">
          <span className="vision-status-label">{vision.statusLabel}</span>
          <p>{vision.status}</p>
        </div>
      </div>
    </section>
  );
}
