import type { Copy } from "../i18n";
import { RELEASES_URL } from "../i18n";
import Section from "./Section";
import { ArrowIcon, WindowsIcon } from "./icons";

type Props = { copy: Copy };

export default function Start({ copy }: Props) {
  const { start } = copy;

  return (
    <Section
      id="start"
      kicker={start.kicker}
      title={start.title}
      lede={start.lede}
      align="center"
    >
      <ol className="start-steps" data-reveal>
        {start.steps.map((step, i) => (
          <li key={step.title}>
            <span className="start-num">{i + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="start-cta" data-reveal>
        <a
          className="btn btn--primary btn--lg"
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          <WindowsIcon width={18} height={18} />
          {start.downloadCta}
          <ArrowIcon className="btn-arrow" width={18} height={18} />
        </a>
      </div>
    </Section>
  );
}
