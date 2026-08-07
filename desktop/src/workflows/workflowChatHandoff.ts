import type { PendingChatHandoff } from "../store";
import type { ReviewWorkflowRun } from "./workflowTypes";

const DISCUSSION_STARTER = "\u8bf7\u6307\u51fa\u5f53\u524d\u9636\u6bb5\u7684\u4e3b\u8981\u98ce\u9669\u548c\u6700\u5c0f\u53ef\u6267\u884c\u4e0b\u4e00\u6b65\u3002";

function buildHandoff(
  projectId: string,
  run: ReviewWorkflowRun,
  activate: boolean,
): PendingChatHandoff {
  return {
    projectId,
    conversationKey: `review-workflow:${run.id}`,
    // Session identity is derived by the Rust ledger; Chat only renders it.
    sessionId: run.sessionId || `wf-${run.id}`,
    workflowRunId: run.id,
    title: `Workflow \u00b7 ${run.title}`,
    // No synthesized stages or JSON snapshot: this conversation is replayed
    // from the workflow's project-scoped audit event log.
    input: "",
    ...(activate ? { draft: DISCUSSION_STARTER } : {}),
    activate,
  };
}

/** Open the ledger-owned session and offer a short, ordinary discussion prompt. */
export function buildWorkflowChatHandoff(
  projectId: string,
  run: ReviewWorkflowRun,
): PendingChatHandoff {
  return buildHandoff(projectId, run, true);
}
