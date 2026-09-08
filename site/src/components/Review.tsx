import { useState } from "react";
import type { Copy } from "../i18n";
import Section from "./Section";
import { CheckIcon, LoopIcon, TraceIcon, CoreIcon } from "./icons";

type Props = { copy: Copy };

const POINT_ICONS = [LoopIcon, TraceIcon, CoreIcon];

export default function Review({ copy }: Props) {
  const { review } = copy;
  const [selectedStage, setSelectedStage] = useState<number>(3); // Default stage: Index 3 (Coverage check)

  const stage = review.stages[selectedStage] || review.stages[0];

  return (
    <Section
      id="review"
      kicker={review.kicker}
      title={review.title}
      lede={review.lede}
      tone="raised"
    >
      {/* Interactive Dual-Agent Architecture Graphic Header */}
      <div className="review-arch-visual" data-reveal>
        <div className="agent-node agent-node--executor">
          <div className="agent-badge">{review.archVisual.executorBadge}</div>
          <div className="agent-title">{review.archVisual.executorTitle}</div>
          <div className="agent-desc">{review.archVisual.executorDesc}</div>
        </div>

        <div className="loop-connector">
          <div className="loop-flow-row loop-flow-row--forward">
            <span className="loop-flow-label">{review.archVisual.submitDraft}</span>
            <div className="loop-flow-line">
              <span className="loop-flow-pulse loop-flow-pulse--forward" />
              <span className="loop-flow-arrow">➔</span>
            </div>
          </div>

          <div className="loop-core-badge">
            <LoopIcon width={15} height={15} />
            <span>{review.archVisual.reviewLoop}</span>
          </div>

          <div className="loop-flow-row loop-flow-row--backward">
            <div className="loop-flow-line">
              <span className="loop-flow-arrow loop-flow-arrow--backward">➔</span>
              <span className="loop-flow-pulse loop-flow-pulse--backward" />
            </div>
            <span className="loop-flow-label">{review.archVisual.rejectRevision}</span>
          </div>
        </div>

        <div className="agent-node agent-node--reviewer">
          <div className="agent-badge agent-badge--purple">{review.archVisual.reviewerBadge}</div>
          <div className="agent-title">{review.archVisual.reviewerTitle}</div>
          <div className="agent-desc">{review.archVisual.reviewerDesc}</div>
        </div>
      </div>

      <div className="review-layout">
        {/* Stage pipeline panel */}
        <div className="stage-panel-container" data-reveal>
          <figure className="stage-panel">
            <figcaption>
              <span>{review.stageLabel} {review.stageSubtitle}</span>
              <span className="stage-hint">{review.stageHint}</span>
            </figcaption>
            <ol className="stage-list">
              {review.stages.map((stg, i) => {
                const isSelected = i === selectedStage;
                return (
                  <li
                    key={stg.name}
                    className={`stage stage--${stg.state}${isSelected ? " stage--selected" : ""}`}
                    onClick={() => setSelectedStage(i)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedStage(i);
                    }}
                  >
                    <span className="stage-num">0{i + 1}</span>
                    <span className="stage-mark">
                      {stg.state === "done" ? <CheckIcon width={13} height={13} /> : null}
                      {stg.state === "review" ? <span className="stage-spinner" /> : null}
                    </span>
                    <span className="stage-name">{stg.name}</span>
                    <span className="stage-state">{review.stateLabels[stg.state]}</span>
                  </li>
                );
              })}
            </ol>
          </figure>

          {/* Interactive Inspector for the clicked stage */}
          <div className="stage-inspector">
            <div className="inspector-head">
              <span className="inspector-num">Step 0{selectedStage + 1}</span>
              <strong>{stage.name}</strong>
              <span className={`inspector-pill inspector-pill--${stage.state}`}>
                {review.stateLabels[stage.state]}
              </span>
            </div>
            <p className="inspector-body">
              {selectedStage === 3
                ? review.inspectorNotes.step3
                : selectedStage === 0
                ? review.inspectorNotes.step0
                : review.inspectorNotes.stepDefault}
            </p>
          </div>
        </div>

        {/* 3 Core Guarantee Cards */}
        <ul className="review-points">
          {review.points.map((point, i) => {
            const Icon = POINT_ICONS[i] ?? POINT_ICONS[0];
            return (
              <li key={point.title} className={`review-card review-card--${i}`} data-reveal>
                <div className="review-card-header">
                  <span className="review-card-icon">
                    <Icon width={22} height={22} />
                  </span>
                  <span className="review-card-tag">Guarantee 0{i + 1}</span>
                </div>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
