/** The desktop tool whose call blocks a turn until the user answers it. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * Bound what one question may render. The desktop already validated the tool
 * input, but the phone renders it into live DOM, so it re-applies its own
 * limits rather than trusting the sizes an upstream model produced.
 */
export const MAX_QUESTION_OPTIONS = 12;
export const MAX_QUESTION_TEXT_CHARS = 2_000;
export const MAX_QUESTION_ANSWER_CHARS = 1_000;

export interface RemoteQuestionOption {
  label: string;
  description?: string;
}

export interface RemoteQuestionSpec {
  question: string;
  header?: string;
  options: RemoteQuestionOption[];
  multiSelect: boolean;
  /** Free-form answers are allowed unless the desktop explicitly opted out. */
  allowCustom: boolean;
}

/**
 * Parses an `AskUserQuestion` tool input into a renderable question.
 *
 * Returns null when the payload is not a well-formed question so the caller
 * can fall back to the ordinary tool card instead of showing an empty prompt.
 * This mirrors the desktop's own parser: both surfaces must agree on what
 * counts as answerable, or the phone would offer to answer a call the desktop
 * never presented as a question.
 */
export function parseRemoteQuestionSpec(input: string): RemoteQuestionSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const question = boundedText(value.question, MAX_QUESTION_TEXT_CHARS);
  if (!question || !Array.isArray(value.options)) {
    return null;
  }
  const options: RemoteQuestionOption[] = [];
  for (const entry of value.options) {
    if (options.length >= MAX_QUESTION_OPTIONS) break;
    if (!isRecord(entry)) continue;
    const label = boundedText(entry.label, MAX_QUESTION_ANSWER_CHARS);
    if (!label) continue;
    const description = boundedText(entry.description, MAX_QUESTION_TEXT_CHARS);
    options.push(description ? { label, description } : { label });
  }
  if (options.length === 0) {
    return null;
  }
  const header = boundedText(value.header, 120);
  return {
    question,
    ...(header ? { header } : {}),
    options,
    multiSelect: value.multiSelect === true,
    allowCustom: value.allowCustom !== false,
  };
}

/**
 * Builds the answer string sent back to the blocked tool call.
 *
 * Selected labels keep the order the desktop offered them in, so the model
 * reads the same answer regardless of the order the user tapped. Returns null
 * when there is nothing to send, which keeps the submit control disabled
 * rather than resolving the tool with an empty answer.
 */
export function composeQuestionAnswer(
  spec: RemoteQuestionSpec,
  selectedIndexes: Iterable<number>,
  customText = "",
): string | null {
  const selected = [...new Set(selectedIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < spec.options.length)
    .sort((left, right) => left - right)
    .map((index) => spec.options[index].label);
  const custom = spec.allowCustom ? customText.trim().slice(0, MAX_QUESTION_ANSWER_CHARS) : "";
  const parts = custom ? [...selected, custom] : selected;
  if (parts.length === 0) {
    return null;
  }
  return parts.join(", ");
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
