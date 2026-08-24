import { useState } from "react";
import type { Copy } from "../i18n";
import Section from "./Section";
import {
  CheckIcon,
  CoreIcon,
  DiskIcon,
  EpisodeIcon,
  FactsIcon,
  LoopIcon,
  TraceIcon,
} from "./icons";

type Props = { copy: Copy };

const LAYER_META = [
  {
    label: "L1",
    Icon: CoreIcon,
    colorRgb: "139, 92, 246",
    arrowDelay: 0,
  },
  {
    label: "L2",
    Icon: EpisodeIcon,
    colorRgb: "59, 130, 246",
    arrowDelay: 0.4,
  },
  {
    label: "L3",
    Icon: FactsIcon,
    colorRgb: "56, 189, 248",
    arrowDelay: 0.8,
  },
];

const BENEFIT_ICONS = [LoopIcon, TraceIcon, DiskIcon];
const FLOW_ICONS = [FactsIcon, EpisodeIcon, CoreIcon];

export default function Memory({ copy }: Props) {
  const { memory } = copy;
  const [active, setActive] = useState<number>(0); // 0=L1 Profile active by default

  const pyramidTiers = memory.pyramid.tiers.map((tier, idx) => ({
    ...tier,
    ...LAYER_META[idx],
  }));

  return (
    <Section id="memory" kicker={memory.kicker} title={memory.title} lede={memory.lede}>

      {/* ── Main two-column layout ── */}
      <div className="mem-layout">

        {/* LEFT: Pyramid */}
        <div className="mem-pyramid-wrap" data-reveal>
          <div className="mem-pyramid">
            {/* Render L1 (top=0) down to L3 (bottom=2) */}
            {pyramidTiers.map((layer, idx) => {
              const isActive = active === idx;
              return (
                <div
                  key={layer.label}
                  className={`mem-pyr-tier mem-pyr-tier--${idx}${isActive ? " mem-pyr-tier--active" : ""}`}
                  style={{ "--layer-rgb": layer.colorRgb } as React.CSSProperties}
                  onClick={() => setActive(idx)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setActive(idx);
                  }}
                >
                  {/* The trapezoid block */}
                  <div className="mem-pyr-block">
                    <span className="mem-pyr-block-badge">{layer.label} · {layer.tier}</span>
                    <span className="mem-pyr-icon">
                      <layer.Icon width={26} height={26} />
                    </span>
                    <span className="mem-pyr-block-name">{layer.name}</span>
                    <span className="mem-pyr-block-sub">({layer.sub})</span>
                    {/* Animated inner glow */}
                    <span className="mem-pyr-shimmer" />
                  </div>

                  {/* Upward arrow between tiers (shown between L3→L2 and L2→L1) */}
                  {idx < 2 && (
                    <div
                      className="mem-pyr-arrow"
                      style={{ "--arrow-delay": `${layer.arrowDelay}s` } as React.CSSProperties}
                    >
                      <div className="mem-arrow-shaft">
                        <div className="mem-arrow-particle" />
                        <div className="mem-arrow-particle mem-arrow-particle--b" />
                      </div>
                      <div className="mem-arrow-head">▲</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: Detail cards */}
        <div className="mem-cards">
          {pyramidTiers.map((layer, idx) => {
            const isActive = active === idx;
            return (
              <div
                key={layer.label}
                className={`mem-card${isActive ? " mem-card--active" : ""}`}
                style={{ "--layer-rgb": layer.colorRgb } as React.CSSProperties}
                onClick={() => setActive(idx)}
                data-reveal
              >
                <div className="mem-card-header">
                  <div className="mem-card-icon-wrap">
                    <layer.Icon width={20} height={20} />
                  </div>
                  <div className="mem-card-title-block">
                    <span className="mem-card-label">{layer.label}</span>
                    <strong className="mem-card-title">
                      {layer.name} ({layer.sub})
                    </strong>
                  </div>
                </div>

                <p className="mem-card-body">{layer.body}</p>

                {/* Tags row */}
                <div className="mem-card-tags">
                  {layer.tags.map((tag) => (
                    <span key={tag} className="mem-card-tag">{tag}</span>
                  ))}
                </div>

                {/* Formation process flow */}
                <div className="mem-flow">
                  <span className="mem-flow-label">{memory.pyramid.flowLabel}</span>
                  <div className="mem-flow-steps">
                    {memory.pyramid.flowSteps.map((fl, fi) => {
                      const FlowIcon = FLOW_ICONS[fi];
                      // highlight current and previous steps based on active layer
                      const isHighlighted = fi >= (2 - idx);
                      return (
                        <div key={fl} className="mem-flow-step-wrap">
                          <div className={`mem-flow-step${isHighlighted && isActive ? " mem-flow-step--lit" : ""}`}
                            style={isHighlighted && isActive ? { "--layer-rgb": layer.colorRgb } as React.CSSProperties : undefined}
                          >
                            <FlowIcon width={16} height={16} />
                          </div>
                          <span className="mem-flow-step-name">{fl}</span>
                          {fi < 2 && <div className="mem-flow-arrow">→</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Synergy Row ── */}
      <div className="mem-synergy">
        <h3 data-reveal>{memory.synergyTitle}</h3>
        <ul>
          {memory.benefits.map((benefit, i) => {
            const Icon = BENEFIT_ICONS[i] ?? BENEFIT_ICONS[0];
            return (
              <li key={benefit.title} className={`mem-benefit mem-benefit--${i}`} data-reveal>
                <span className="mem-benefit-icon">
                  <Icon width={20} height={20} />
                </span>
                <span className="mem-benefit-check">
                  <CheckIcon width={12} height={12} />
                </span>
                <h4>{benefit.title}</h4>
                <p>{benefit.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
