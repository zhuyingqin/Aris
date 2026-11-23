// The controller's record of plugin review rubrics, summarised the same way
// wherever it is shown: the task board, plugin pages that follow their tasks.
import type { ReviewRubricRecord } from "./api/tauri";

export interface RubricCounts {
  /** Criteria the packet carried. */
  sent: number;
  violated: number;
  /** Sent, but the Reviewer said nothing about them. */
  unreported: number;
}

export function rubricCounts(record: ReviewRubricRecord | null | undefined): RubricCounts {
  const checks = record?.checks ?? [];
  return {
    sent: checks.length,
    violated: checks.filter((check) => check.result === "violated").length,
    unreported: checks.filter((check) => check.result === "unreported").length,
  };
}
