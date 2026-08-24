import type { Copy } from "../i18n";
import Section from "./Section";
import { LiteratureIcon, LabIcon, TypesetIcon, ReviewIcon, CheckIcon } from "./icons";

type Props = { copy: Copy };

const ICONS = [LiteratureIcon, LabIcon, TypesetIcon, ReviewIcon];

export default function Does({ copy }: Props) {
  return (
    <Section
      id="does"
      kicker={copy.does.kicker}
      title={copy.does.title}
      lede={copy.does.lede}
    >
      <ul className="job-grid">
        {copy.does.items.map((item, i) => {
          const Icon = ICONS[i] ?? ICONS[0];
          return (
            <li key={item.name} className={`job-card job-card--${i}`} data-reveal>
              <div className="job-card-top">
                <span className="job-icon">
                  <Icon width={22} height={22} />
                </span>
                <span className="job-step-tag">0{i + 1}</span>
              </div>
              <h3>{item.name}</h3>
              <p>{item.body}</p>

              {/* Mini visual widgets for each capability card */}
              <div className="job-mini-visual">
                {i === 0 && (
                  <div className="job-widget job-widget--lit">
                    <div className="job-lit-nodes">
                      <span className="job-node">Scopus</span>
                      <span className="job-node">OpenAlex</span>
                      <span className="job-node">arXiv</span>
                    </div>
                    <div className="job-lit-stat">
                      <CheckIcon width={12} height={12} /> {copy.does.widgets.litStat}
                    </div>
                  </div>
                )}

                {i === 1 && (
                  <div className="job-widget job-widget--lab">
                    <div className="job-lab-code">
                      <span>exec(run_bench.py)</span>
                      <span className="job-status-ok">✓ Auto-debugged Error 404</span>
                    </div>
                    <div className="job-lab-chart">
                      <span style={{ height: "40%" }} />
                      <span style={{ height: "65%" }} />
                      <span style={{ height: "90%" }} />
                      <span style={{ height: "75%" }} />
                    </div>
                  </div>
                )}

                {i === 2 && (
                  <div className="job-widget job-widget--typeset">
                    <div className="job-tex-code">
                      <span>{"\\begin{equation} L_{\\text{diff}} \\end{equation}"}</span>
                    </div>
                    <div className="job-pdf-badge">PDF Compiled (0.3s)</div>
                  </div>
                )}

                {i === 3 && (
                  <div className="job-widget job-widget--review">
                    <div className="job-rev-score">
                      <strong>98/100</strong> {copy.does.widgets.reviewVerdict}
                    </div>
                    <div className="job-rev-check">
                      <CheckIcon width={12} height={12} /> {copy.does.widgets.reviewStatus}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
