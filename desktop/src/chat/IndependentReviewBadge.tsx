import type { ChatBlock } from "../types";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";

type ReviewBlock = Extract<ChatBlock, { kind: "review" }>;

function reviewerName(block: ReviewBlock, language: "cn" | "en") {
  if (block.reviewerModel) return block.reviewerModel;
  return language === "cn" ? "独立 Reviewer Agent" : "Independent Reviewer Agent";
}

function reviewStatus(block: ReviewBlock, language: "cn" | "en") {
  const reviewer = reviewerName(block, language);
  if (language === "cn") {
    if (block.phase === "reviewing") return `${reviewer} 正在独立审核`;
    if (block.phase === "revising") {
      return `Executor 正按 ${reviewer} 的意见修订 ${block.revision ?? block.attempt}/${block.maxRevisions}`;
    }
    if (block.verdict === "pass") return `${reviewer} 已通过审核`;
    if (block.verdict === "revise") return `${reviewer} 要求继续修订`;
    if (block.verdict === "needs_user") return `${reviewer} 需要用户决策`;
    if (block.verdict === "unavailable") return "独立 Reviewer 当前不可用";
    return `${reviewer} 已完成审核`;
  }
  if (block.phase === "reviewing") return `${reviewer} is independently reviewing`;
  if (block.phase === "revising") {
    return `Executor is applying ${reviewer}'s feedback ${block.revision ?? block.attempt}/${block.maxRevisions}`;
  }
  if (block.verdict === "pass") return `${reviewer} passed the answer`;
  if (block.verdict === "revise") return `${reviewer} requested another revision`;
  if (block.verdict === "needs_user") return `${reviewer} needs a user decision`;
  if (block.verdict === "unavailable") return "Independent Reviewer is unavailable";
  return `${reviewer} completed the review`;
}

export default function IndependentReviewBadge({
  block,
  onOpen,
}: {
  block: ReviewBlock;
  onOpen: () => void;
}) {
  const language = useStore((state) => state.language);
  const status = reviewStatus(block, language);
  const provider = block.reviewerProvider?.trim();
  const active = block.phase === "reviewing" || block.phase === "revising";
  const label = language === "cn"
    ? `查看独立 Reviewer 审查详情：${status}`
    : `Open independent Reviewer details: ${status}`;

  return (
    <button
      type="button"
      className={`independent-review-badge phase-${block.phase}${block.verdict ? ` verdict-${block.verdict}` : ""}`}
      onClick={onOpen}
      aria-label={label}
    >
      <span className="independent-review-badge-avatar" aria-hidden="true">R</span>
      <span className="independent-review-badge-copy">
        <span className="independent-review-badge-eyebrow">
          Reviewer Agent{provider ? ` · ${provider}` : ""}
        </span>
        <strong aria-live="polite">{status}</strong>
      </span>
      <span className={`independent-review-badge-state${active ? " active" : ""}`} aria-hidden="true">
        {active ? <span className="independent-review-badge-spinner" /> : <SvgIcon name="check" size={14} />}
      </span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
