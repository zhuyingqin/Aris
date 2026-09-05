// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TypesetExternalChangeReview, { type ExternalChangeReviewCopy } from "../TypesetExternalChangeReview";

const copy: ExternalChangeReviewCopy = {
  title: (name) => `Review external changes to ${name}`,
  description: "External changes need review.",
  localDraftWarning: "Local draft",
  additions: (count) => `${count} added`,
  deletions: (count) => `${count} deleted`,
  showChanges: "Show changes",
  hideChanges: "Hide changes",
  accept: "Accept all in this file",
  reject: "Reject all in this file",
  answeredAccept: "Accepted",
  answeredReject: "Rejected",
  answeredPartial: "Answered change by change",
  accepting: "Accepting…",
  rejecting: "Rejecting…",
  apply: "Apply reviewed changes",
  applying: "Applying…",
  acceptOne: "Accept this change",
  rejectOne: "Reject this change",
  acceptedOne: "Accepted",
  rejectedOne: "Rejected",
  undoOne: "Undo",
  pending: "Pending",
  oldLine: "old",
  newLine: "new",
  reviewInEditor: "View incoming changes",
  viewDraft: "View my draft",
  previousChange: "Previous change",
  nextChange: "Next change",
  changePosition: (current, total) => `${current} / ${total}`,
  reviewed: (remaining) => `Reviewed · ${remaining}`,
  reviewNext: "Review next file",
  edited: "Includes your edits",
  discardEdits: "Discard my edits",
  tooLargeTitle: "Large change · choose one complete version",
  tooLargeDetail: (added, removed, approximate) => `Too large (${approximate ? "approximately " : ""}${added} added, ${removed} deleted).`,
  takeIncoming: "Use disk version",
  keepLocal: "Keep my draft",
  compare: "Compare both versions",
  closeCompare: "Close comparison",
  localVersion: "My draft",
  incomingVersion: "Disk version",
  compareTruncated: "Middle omitted",
};

function renderReview(overrides: Partial<ComponentProps<typeof TypesetExternalChangeReview>> = {}) {
  return render(
    <TypesetExternalChangeReview
      name="paper.tex"
      current="local line\nmy paragraph"
      incoming="disk line\nagent paragraph"
      dirty
      busy={null}
      decisions={[]}
      staged={false}
      remaining={0}
      actor="Changed by Chat"
      origin="chat"
      showActor
      copy={copy}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      onApply={vi.fn()}
      onNext={null}
      tooLargeToChunk
      wholeFileDecision={null}
      onTakeIncoming={vi.fn()}
      onKeepLocal={vi.fn()}
      {...overrides}
    />,
  );
}

describe("TypesetExternalChangeReview", () => {
  afterEach(() => cleanup());

  it("offers two complete-file choices and a side-by-side comparison for a large diff", () => {
    const onTakeIncoming = vi.fn();
    const onKeepLocal = vi.fn();
    renderReview({ onTakeIncoming, onKeepLocal });

    expect(screen.getByRole("button", { name: "Use disk version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare both versions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply reviewed changes" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Compare both versions" }));
    const dialog = screen.getByRole("dialog", { name: "Compare both versions" });
    expect(within(dialog).getByText("My draft")).toBeTruthy();
    expect(within(dialog).getByText("Disk version")).toBeTruthy();
    expect(dialog.textContent).toContain("my paragraph");
    expect(dialog.textContent).toContain("agent paragraph");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Use disk version" }));
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
    expect(onTakeIncoming).toHaveBeenCalledTimes(1);
  });

  it("marks the selected complete-file answer instead of deriving it from empty hunks", () => {
    renderReview({ wholeFileDecision: "local" });

    expect(screen.getByRole("button", { name: "Keep my draft" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Use disk version" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("bounds the side-by-side preview without changing the complete-file decision", () => {
    const hugeLocal = `LOCAL START\n${"l".repeat(180_000)}\nLOCAL END`;
    const hugeIncoming = `DISK START\n${"d".repeat(180_000)}\nDISK END`;
    renderReview({ current: hugeLocal, incoming: hugeIncoming, added: 90_000, removed: 90_000 });

    fireEvent.click(screen.getByRole("button", { name: "Compare both versions" }));
    const dialog = screen.getByRole("dialog", { name: "Compare both versions" });
    expect(dialog.textContent).toContain("Middle omitted");
    expect(dialog.textContent).toContain("LOCAL START");
    expect(dialog.textContent).toContain("LOCAL END");
    expect(dialog.textContent).toContain("DISK START");
    expect(dialog.textContent).toContain("DISK END");
    expect(dialog.textContent!.length).toBeLessThan(340_000);
  });

  /**
   * The answered file's banner stays up until the whole change set resolves. It
   * used to offer the same two buttons in the same state as an unanswered one,
   * so pressing the answer already recorded re-staged identical bytes and moved
   * nothing on screen — a click that reads as a broken button.
   */
  it("wears the answer this file already carries", () => {
    const onReject = vi.fn();
    renderReview({ tooLargeToChunk: false, decisions: ["accept", "accept"], staged: true, stagedDecision: "accept", onReject });

    const accepted = screen.getByRole("button", { name: "Accepted" });
    expect(accepted.getAttribute("aria-pressed")).toBe("true");
    expect(accepted.classList.contains("selected")).toBe(true);
    expect(screen.queryByRole("button", { name: "Accept all in this file" })).toBeNull();

    // Changing the answer stays one click away, and it is the button that is
    // not already selected.
    const reject = screen.getByRole("button", { name: "Reject all in this file" });
    expect(reject.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(reject);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  /**
   * Neither whole-file button carries a change-by-change answer, so the pair
   * alone cannot distinguish this file from an unanswered one — which is what
   * made pressing "Accept all in this file" on an already-answered file look
   * like a broken button. The state has to be written somewhere.
   */
  it("claims neither word when a renamed file's operations disagree, and says so", () => {
    renderReview({ tooLargeToChunk: false, decisions: ["accept", "reject"], staged: true, stagedDecision: "partial" });

    expect(screen.getByRole("button", { name: "Accept all in this file" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Reject all in this file" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Answered change by change")).toBeTruthy();
  });

  it("leaves an unanswered file's pair unpressed", () => {
    renderReview({ tooLargeToChunk: false, decisions: ["pending", "pending"], staged: false });

    const accept = screen.getByRole("button", { name: "Accept all in this file" });
    // Not `false`: an unanswered file has no answer to be the opposite of, and
    // a toggle that reads "off" would claim it was answered "no".
    expect(accept.getAttribute("aria-pressed")).toBeNull();
  });

  it("expands concrete, actionable hunks below the review bar", () => {
    const onDecideChange = vi.fn();
    renderReview({
      tooLargeToChunk: false,
      decisions: ["pending"],
      changesExpanded: true,
      reviewChanges: [{
        id: "1:2:1:2:0",
        oldStart: 1,
        oldEnd: 2,
        newStart: 1,
        newEnd: 2,
        beforeLines: ["old sentence"],
        afterLines: ["new sentence"],
        lines: [
          { kind: "removed", text: "old sentence", oldLine: 2, newLine: null },
          { kind: "added", text: "new sentence", oldLine: null, newLine: 2 },
        ],
      }],
      onDecideChange,
    });

    const drawer = screen.getByLabelText("paper.tex changes");
    expect(drawer.textContent).toContain("old sentence");
    expect(drawer.textContent).toContain("new sentence");
    fireEvent.click(within(drawer).getByRole("button", { name: "Accept this change" }));
    expect(onDecideChange).toHaveBeenCalledWith(0, "accept");
  });

  it("labels bounded-fallback line counts as approximate", () => {
    renderReview({ added: 900, removed: 900, approximateStats: true });
    expect(screen.getByText(/approximately 900 added/)).toBeTruthy();
  });
});
