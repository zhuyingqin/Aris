import type { Copy } from "../i18n";
import Section from "./Section";
import { CheckIcon } from "./icons";

type Props = { copy: Copy };

export default function Local({ copy }: Props) {
  const { local } = copy;

  return (
    <Section id="local" kicker={local.kicker} title={local.title} lede={local.lede}>
      {/* Architecture Topology Diagram */}
      <div className="local-arch-card" data-reveal>
        <div className="local-arch-shield">
          <span className="local-shield-icon">🛡️</span>
          <div className="local-shield-text">
            <strong>{local.topology.shieldTitle}</strong>
            <span>{local.topology.shieldDesc}</span>
          </div>
        </div>

        <div className="local-topology">
          <div className="topo-box topo-box--device">
            <div className="topo-box-head">
              <span className="topo-dot" />
              <span>{local.topology.deviceBoxTitle}</span>
            </div>
            <div className="topo-items">
              {local.topology.devicePills.map((pill) => (
                <span key={pill} className="topo-pill">{pill}</span>
              ))}
            </div>
          </div>

          <div className="topo-connector">
            <div className="topo-line">
              <span className="topo-label">{local.topology.connectorLabel}</span>
              <span className="topo-pulse" />
            </div>
          </div>

          <div className="topo-box topo-box--models">
            <div className="topo-box-head">
              <span className="topo-dot topo-dot--green" />
              <span>{local.topology.modelsBoxTitle}</span>
            </div>
            <div className="topo-items">
              {local.topology.modelPills.map((pill, i) => (
                <span key={pill} className={`topo-pill${i === 0 ? " topo-pill--accent" : ""}`}>{pill}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <ul className="local-points" data-reveal>
        {local.points.map((point) => (
          <li key={point}>
            <span className="local-check">
              <CheckIcon width={14} height={14} />
            </span>
            <span>{point}</span>
          </li>
        ))}
      </ul>

      <p className="local-note" data-reveal>
        {local.note}
      </p>
    </Section>
  );
}
