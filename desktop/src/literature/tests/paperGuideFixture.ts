import type { GuideLesson, PaperGuide } from "../paperReadingApi";

export function guideFixture(): PaperGuide {
  const result: GuideLesson = {
    intuition: "缩放让分数在给定假设下保持相近的量级。",
    notation: "$d_k$ 是 key 和 query 的维度。",
    assumptions: "各分量独立、均值为零、方差为一。",
    steps: [{ title: "从点积方差开始", explanation: "独立性使各项的方差可以相加。", origin: "teaching" }],
    example: "构造两个分数 0 和 2，观察缩放前后 softmax 的变化。",
    evidence: "原文脚注明确给出了假设，不是对任意输入的保证。",
    checkQuestion: "如果分量相关，还能直接相加吗？", checkAnswer: "不能，还需要考虑协方差项。",
    sourcePages: [2], cautions: ["例子不代表论文的实验结果。"],
  };
  const topics = [
    { kind: "figure" as const, title: "数据如何经过模型？", learningGoal: "看懂模块和箭头。", sourcePages: [1] },
    { kind: "formula" as const, title: "为什么除以维度的平方根？", learningGoal: "理解缩放依赖的假设。", sourcePages: [2] },
  ];
  return {
    protocolVersion: "paper-guide-v1",
    outline: { status: "completed", error: null, attempts: [], result: {
      overview: [
        { kind: "problem", content: "这篇论文解决序列建模中的并行计算问题。", sourcePages: [1] },
        { kind: "method", content: "用注意力组织信息交换。", sourcePages: [1] },
        { kind: "evidence", content: "结果对应特定翻译任务。", sourcePages: [2] },
      ], topics, cautions: [],
    } },
    lessons: topics.map((topic, index) => ({ topic, task: { status: "completed", result: { ...result, sourcePages: [index + 1] }, attempts: [], error: null } })),
  };
}
