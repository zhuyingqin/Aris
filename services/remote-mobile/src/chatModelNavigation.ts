import type { ControlResponse } from "./control";

export interface RemoteModelOption {
  value: string;
  label: string;
  description: string | null;
}

export interface RemoteChatModelState {
  model: string | null;
  options: RemoteModelOption[];
}

/**
 * Validates the small, credential-free model projection returned for the
 * selected desktop conversation. A response that does not belong to the
 * currently selected project/session must never update the phone's picker.
 */
export function chatModelStateFromResponse(
  response: ControlResponse,
  projectId: string,
  sessionId: string,
): RemoteChatModelState | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const resultValue = response.outcome.result;
  if (
    (resultValue.type !== "chat_model_options" && resultValue.type !== "chat_session_model_updated") ||
    resultValue.project_id !== projectId ||
    resultValue.session_id !== sessionId ||
    (resultValue.model !== null && typeof resultValue.model !== "string") ||
    !Array.isArray(resultValue.options)
  ) {
    return null;
  }

  const options: RemoteModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of resultValue.options) {
    if (
      !isRecord(entry) ||
      typeof entry.value !== "string" ||
      !entry.value.trim() ||
      typeof entry.label !== "string" ||
      (entry.description !== null && entry.description !== undefined && typeof entry.description !== "string") ||
      seen.has(entry.value)
    ) {
      return null;
    }
    seen.add(entry.value);
    options.push({
      value: entry.value,
      label: entry.label.trim() || entry.value,
      description: typeof entry.description === "string" && entry.description.trim()
        ? entry.description.trim()
        : null,
    });
  }
  const model = typeof resultValue.model === "string" && resultValue.model.trim()
    ? resultValue.model.trim()
    : null;
  // The desktop can keep an existing conversation override while its model
  // registry is being refreshed. Keep that effective model visible rather
  // than rejecting the complete response and making the picker appear broken.
  if (model !== null && !options.some((option) => option.value === model)) {
    options.unshift({
      value: model,
      label: model,
      description: "当前对话模型",
    });
  }
  return { model, options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
