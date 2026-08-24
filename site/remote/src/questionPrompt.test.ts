import { describe, expect, it } from "vitest";

import {
  composeQuestionAnswer,
  MAX_QUESTION_OPTIONS,
  parseRemoteQuestionSpec,
  type RemoteQuestionSpec,
} from "./questionPrompt";

const SPEC = (overrides: Partial<RemoteQuestionSpec> = {}): RemoteQuestionSpec => ({
  question: "选择部署目标",
  options: [{ label: "预发布" }, { label: "生产" }, { label: "跳过" }],
  multiSelect: false,
  allowCustom: true,
  ...overrides,
});

describe("parseRemoteQuestionSpec", () => {
  it("reads a well-formed question with its options", () => {
    const spec = parseRemoteQuestionSpec(JSON.stringify({
      question: "选择部署目标",
      header: "Deploy",
      options: [
        { label: "预发布", description: "先在预发布验证" },
        { label: "生产" },
      ],
    }));

    expect(spec).toEqual({
      question: "选择部署目标",
      header: "Deploy",
      options: [
        { label: "预发布", description: "先在预发布验证" },
        { label: "生产" },
      ],
      multiSelect: false,
      // A desktop that does not opt out still allows a free-form answer.
      allowCustom: true,
    });
  });

  it("honours explicit multiSelect and allowCustom flags", () => {
    const spec = parseRemoteQuestionSpec(JSON.stringify({
      question: "选择要跑的测试",
      options: [{ label: "单元" }, { label: "集成" }],
      multiSelect: true,
      allowCustom: false,
    }));

    expect(spec?.multiSelect).toBe(true);
    expect(spec?.allowCustom).toBe(false);
  });

  it("rejects payloads the phone must not offer to answer", () => {
    expect(parseRemoteQuestionSpec("not json")).toBeNull();
    expect(parseRemoteQuestionSpec(JSON.stringify({ options: [{ label: "a" }] }))).toBeNull();
    expect(parseRemoteQuestionSpec(JSON.stringify({ question: "  ", options: [{ label: "a" }] }))).toBeNull();
    expect(parseRemoteQuestionSpec(JSON.stringify({ question: "q", options: [] }))).toBeNull();
    expect(parseRemoteQuestionSpec(JSON.stringify({ question: "q", options: "all" }))).toBeNull();
    expect(parseRemoteQuestionSpec(JSON.stringify({ question: "q", options: [{ value: 1 }] }))).toBeNull();
  });

  it("drops unusable options but keeps the rest of the question", () => {
    const spec = parseRemoteQuestionSpec(JSON.stringify({
      question: "q",
      options: [{ label: "" }, "nope", { label: "保留" }, null],
    }));

    expect(spec?.options).toEqual([{ label: "保留" }]);
  });

  it("bounds how much one question may render", () => {
    const spec = parseRemoteQuestionSpec(JSON.stringify({
      question: "q",
      options: Array.from({ length: MAX_QUESTION_OPTIONS + 8 }, (_, index) => ({
        label: `option-${index}`,
      })),
    }));

    expect(spec?.options).toHaveLength(MAX_QUESTION_OPTIONS);
  });
});

describe("composeQuestionAnswer", () => {
  it("answers a single choice with its label", () => {
    expect(composeQuestionAnswer(SPEC(), [1])).toBe("生产");
  });

  it("keeps the desktop's option order regardless of tap order", () => {
    expect(composeQuestionAnswer(SPEC({ multiSelect: true }), [2, 0])).toBe("预发布, 跳过");
  });

  it("appends a free-form answer after the selected labels", () => {
    expect(composeQuestionAnswer(SPEC({ multiSelect: true }), [0], "  也跑一次冒烟  "))
      .toBe("预发布, 也跑一次冒烟");
  });

  it("ignores free text when the desktop opted out of custom answers", () => {
    expect(composeQuestionAnswer(SPEC({ allowCustom: false }), [0], "别的")).toBe("预发布");
    expect(composeQuestionAnswer(SPEC({ allowCustom: false }), [], "别的")).toBeNull();
  });

  it("never resolves a blocked tool call with an empty answer", () => {
    expect(composeQuestionAnswer(SPEC(), [])).toBeNull();
    expect(composeQuestionAnswer(SPEC(), [], "   ")).toBeNull();
  });

  it("discards selections that are not real options", () => {
    expect(composeQuestionAnswer(SPEC(), [9])).toBeNull();
    expect(composeQuestionAnswer(SPEC({ multiSelect: true }), [-1, 0, 1.5, 99])).toBe("预发布");
  });

  it("does not repeat an option that was toggled twice", () => {
    expect(composeQuestionAnswer(SPEC({ multiSelect: true }), [1, 1])).toBe("生产");
  });
});
