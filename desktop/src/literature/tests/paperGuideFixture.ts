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

/** A guide in the layered protocol: leveled topics, glossary, independent review. */
export function layeredGuideFixture(): PaperGuide {
  const lesson = (plainSummary: string): GuideLesson => ({
    plainSummary,
    analogy: "像先把每个人的发言音量调到差不多再比较。类比不成立的地方：论文除以的是平方根，而不是人数。",
    prerequisites: [{ concept: "点积", explanation: "把两个向量对应位置相乘再相加，例如 [1,2]·[3,4]=11。" }],
    intuition: "维度越大，点积的数值越容易变大，softmax 会变得过于集中。",
    notation: "$d_k$ 是 key 和 query 的维度。",
    assumptions: "各分量独立、均值为零、方差为一。",
    steps: [
      { title: "先看点积的大小", explanation: "维度增加时，方差按 $d_k$ 增长。", origin: "paper" },
      { title: "除以平方根", explanation: "除以 $\\sqrt{d_k}$ 让方差回到 1。", origin: "teaching" },
    ],
    example: "给定两个分数 4 和 0，维度 16：缩放后变为 1 和 0。",
    misconceptions: [{ misconception: "缩放保证训练一定稳定。", correction: "它只在给定假设下控制方差，不是训练稳定性的保证。" }],
    evidence: "原文脚注给出假设。",
    checkQuestion: "为什么是平方根？", checkAnswer: "因为方差按维度线性增长，标准差按平方根增长。",
    sourcePages: [2], cautions: [],
  });
  const review = (round: number, verdict: "pass" | "needs_revision") => ({
    round, verdict, summary: verdict === "pass" ? "与原文一致。" : "把置换等变写成了置换不变。",
    issues: verdict === "pass" ? [] : [{ severity: "major" as const, location: "misconceptions", problem: "把置换等变写成了置换不变。", suggestion: "改为置换等变。" }],
    reviewer: "openai / reviewer-model", sessionId: `review-${round}`, reviewedAt: "2026-09-28T00:00:00Z",
  });
  const topics = [
    { kind: "concept" as const, level: "foundation" as const, title: "什么是注意力？", learningGoal: "理解加权求和。", prerequisites: [], sourcePages: [1] },
    { kind: "formula" as const, level: "core" as const, title: "为什么要缩放？", learningGoal: "理解缩放的前提。", prerequisites: ["点积"], sourcePages: [2] },
  ];
  return {
    protocolVersion: "paper-guide-v2",
    reviewRequired: true,
    readerGoal: "改进检索模型",
    outline: { status: "completed", error: null, attempts: [], result: {
      oneSentence: "这篇论文只用注意力来翻译句子，从而可以并行计算。",
      overview: [
        { kind: "problem", content: "循环网络难以并行。", sourcePages: [1] },
        { kind: "method", content: "用注意力直接连接任意两个位置。", sourcePages: [1] },
        { kind: "evidence", content: "翻译任务上 BLEU 更高。", sourcePages: [2] },
      ],
      glossary: [{ term: "注意力", plain: "按相关程度给信息加权平均。", sourcePages: [1] }],
      topics, cautions: [], relevance: "注意力打分方式可用于你的检索模型。",
    } },
    lessons: [
      { topic: topics[0], task: { status: "completed", result: lesson("注意力就是按相关程度加权。"), attempts: [], error: null }, reviews: [review(0, "pass")], revision: null },
      {
        topic: topics[1],
        task: { status: "completed", result: lesson("第一版草稿。"), attempts: [], error: null },
        reviews: [review(0, "needs_revision"), review(1, "pass")],
        revision: { status: "completed", result: lesson("缩放让分数保持在合适的范围。"), attempts: [], error: null },
      },
    ],
  };
}
