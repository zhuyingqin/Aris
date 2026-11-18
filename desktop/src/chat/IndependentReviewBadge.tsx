import type { Language } from "../store";
import type { ChatBlock } from "../types";
import { useStore } from "../store";
import { tr } from "../language";
import { SvgIcon } from "../SvgIcon";

type ReviewBlock = Extract<ChatBlock, { kind: "review" }>;

function reviewerName(block: ReviewBlock, language: Language) {
  if (block.reviewerModel) return block.reviewerModel;
  return tr(language, "独立 Reviewer Agent", "Independent Reviewer Agent", "Agente Reviewer independiente");
}

function reviewStatus(block: ReviewBlock, language: Language) {
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
  if (language === "es") {
    if (block.phase === "reviewing") return `${reviewer} está revisando de forma independiente`;
    if (block.phase === "revising") {
      return `Executor está aplicando los comentarios de ${reviewer} ${block.revision ?? block.attempt}/${block.maxRevisions}`;
    }
    if (block.verdict === "pass") return `${reviewer} aprobó la respuesta`;
    if (block.verdict === "revise") return `${reviewer} pidió otra revisión`;
    if (block.verdict === "needs_user") return `${reviewer} necesita que decidas`;
    if (block.verdict === "unavailable") return "El Reviewer independiente no está disponible";
    return `${reviewer} completó la revisión`;
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
  const label = tr(
    language,
    `查看独立 Reviewer 审查详情：${status}`,
    `View independent Reviewer details: ${status}`,
    `Abrir los detalles del Reviewer independiente: ${status}`,
  );

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
