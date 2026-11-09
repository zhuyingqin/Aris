import type { StyleFamily } from "./figureStyles";

type Copy = [cn: string, en: string];
export interface FigureScenario {
  id: string;
  family: StyleFamily;
  discipline: Copy;
  title: Copy;
  features: Copy;
  description: Copy;
  sources: { title: string; url: string }[];
}

/** Examples show where a visual vocabulary is useful, not which disciplines
 * are allowed to use it. Content is inserted only by an explicit scene action. */
export const FIGURE_SCENARIOS: Record<StyleFamily, FigureScenario> = {
  schematic: {
    id: "ofdm", family: "schematic", discipline: ["通信工程", "Communications"], title: ["OFDM 收发链", "OFDM transceiver"], features: ["导频支路 · 信道均衡 · 循环前缀", "Pilots · equalization · cyclic prefix"],
    description: [
      "OFDM 收发链与导频辅助均衡\n上方发射链从左到右：输入比特 → QAM 映射 → 导频插入 → IFFT → 添加循环前缀（CP）→ 多径信道。已知导频单独输入导频插入模块。\n下方接收链从右到左：多径信道 → 移除 CP → FFT → 均衡器 → QAM 解映射 → 输出比特，箭头沿实际信号方向。FFT 输出另一路与接收端已知导频共同进入信道估计，信道估计结果作为均衡器的第二个输入。\n单独放大循环前缀结构：符号尾部复制到符号前部，用细引线关联添加 CP 模块；引线不表示信号流。发射、信道、接收和估计层次清楚，不添加 RF 硬件、误码率曲线或未经提供的参数。",
      "OFDM transceiver with pilot-assisted equalization\nUpper transmitter chain, left to right: input bits → QAM mapper → pilot insertion → IFFT → add cyclic prefix (CP) → multipath channel. Known pilots feed pilot insertion separately.\nLower receiver chain, right to left: channel → remove CP → FFT → equalizer → QAM demapper → output bits. Arrowheads follow the actual signal path. A branch from FFT and the receiver's known-pilot reference feed channel estimation; the estimate is a second input to the equalizer.\nA separate cyclic-prefix inset shows the symbol tail copied to its front. Connect the inset to Add CP with an undirected detail leader. Distinguish transmitter, channel, receiver and estimation. Do not invent RF hardware, BER curves or numerical parameters.",
    ], sources: [{ title: "MathWorks: OFDM Transmitter and Receiver", url: "https://www.mathworks.com/help/comm/ug/ofdm-transmitter-and-receiver.html" }],
  },
  theory: {
    id: "hmm", family: "theory", discipline: ["概率模型", "Probabilistic models"], title: ["隐马尔可夫模型推断", "Hidden Markov inference"], features: ["隐状态与观测 · 边缘后验 · 最优路径", "Latent/observed nodes · marginals · joint path"],
    description: [
      "隐马尔可夫模型与两种推断任务\n上方画五个空心隐状态节点 z₁ → z₂ → z₃ → z₄ → z₅，每个隐状态向下指向对应实心观测 x₁…x₅。π 指向初始状态，状态转移边标 A，发射边标 B；观测之间不连边，观测不反向指向隐状态。\n下方独立画观测序列的推断流程：x₁…x₅ 分别进入 Forward–backward → State marginals，以及 Viterbi → Best joint path。边缘后验标 p(zₜ | x₁:₅)，最优联合路径标 argmax p(z₁:₅ | x₁:₅)，不要混淆逐时刻最优状态与联合最优路径。\n用空心与实心节点区分潜变量和观测，生成图与计算流程分区，不画回到生成图的推断箭头，不编造转移概率或数值结果。",
      "Hidden Markov model and two inference tasks\nShow five open latent vertices z₁ → z₂ → z₃ → z₄ → z₅, each emitting downward to its filled observation x₁…x₅. π enters the initial state; annotate a transition with A and an emission with B. Observations have no inter-observation edges or arrows back to latent vertices.\nBelow, separately show inference from x₁…x₅: Forward–backward → State marginals, and Viterbi → Best joint path. Annotate the marginal posterior p(zₜ | x₁:₅) and the joint-path objective argmax p(z₁:₅ | x₁:₅); do not equate marginal decoding with the best joint sequence.\nUse open/filled geometry to distinguish latent/observed variables. Separate the generative graph from the computation workflow, with no inference edges back into the graph and no invented probabilities or results.",
    ], sources: [{ title: "Rabiner: A Tutorial on Hidden Markov Models (1989)", url: "https://doi.org/10.1109/5.18626" }],
  },
  panels: {
    id: "multiome", family: "panels", discipline: ["生物信息学", "Bioinformatics"], title: ["单细胞多组学整合", "Single-cell multiome"], features: ["配对细胞 · 双模态处理 · WNN 整合", "Paired cells · dual modality · WNN"],
    description: [
      "配对单细胞 RNA 与 ATAC 多组学整合\n同一批细胞的配对测量按匹配的细胞条形码分成两条并行链。RNA 区域：RNA counts → RNA QC → SCTransform → PCA。ATAC 区域：Peak counts → ATAC QC → TF–IDF → LSI。用匹配条形码注释说明输入配对，引线不表示跨模态计算。\nPCA 与 LSI 各自输入 WNN graph → Clustering → Cell annotation。RNA markers 和 Chromatin accessibility 作为两个证据输入支持细胞注释，不能把 WNN 画成仅由一种模态产生。\n明确父级模态分区、内部计算步骤和联合分析区；只画矩阵与图结构的示意，不添加真实样本数量、QC 阈值、聚类散点数据或推断出的调控结论。",
      "Paired single-cell RNA and ATAC integration\nPaired measurements from the same cells split into parallel modalities matched by cell barcodes. RNA panel: RNA counts → RNA QC → SCTransform → PCA. ATAC panel: peak counts → ATAC QC → TF–IDF → LSI. Barcode annotations are undirected leaders, not cross-modality computational edges.\nPCA and LSI each feed WNN graph → Clustering → Cell annotation. RNA markers and chromatin accessibility are separate evidence inputs supporting annotation. WNN must not appear to use only one modality.\nUse parent modality regions, aligned internal steps and a distinct joint-analysis region. Matrix/network objects are illustrative. Do not invent sample counts, QC thresholds, scatter data or regulatory conclusions.",
    ], sources: [
      { title: "Hao et al.: Integrated analysis of multimodal single-cell data (2021)", url: "https://doi.org/10.1016/j.cell.2021.04.048" },
      { title: "Seurat: Weighted Nearest Neighbor Analysis", url: "https://satijalab.org/seurat/articles/weighted_nearest_neighbor_analysis" },
    ],
  },
  tensors: {
    id: "transformer", family: "tensors", discipline: ["深度学习", "Deep learning"], title: ["Transformer 编码器", "Transformer encoder"], features: ["Q/K/V 投影 · 双残差 · 注意力展开", "Q/K/V projections · residuals · attention detail"],
    description: [
      "Transformer 编码器与多头自注意力展开\n采用原始 post-norm 编码器：Input tokens → Token embedding，与 Positional encoding 在加法节点相加，再进入 N× 编码层。编码层自下而上：Multi-head self-attention → Add & Norm → Feed-forward → Add & Norm → 层外 Output embeddings。第一条残差从注意力输入绕过注意力进入第一处 Add & Norm；第二条从前馈输入绕过前馈进入第二处 Add & Norm。\n右侧独立放大 Attention detail，用无方向细引线关联自注意力模块。相同输入分别投影为 Q、K、V；Q 和 K → QKᵀ / √dₖ → Softmax；Softmax 与 V → Weighted sum；多头结果 → Concat → Output projection。\n用层叠矩阵表达张量，文字保持水平，放大图不额外构成数据流循环。不要画成 pre-norm、解码器交叉注意力或因果掩码，不添加任务头，也不编造固定层数、头数或张量维度。",
      "Transformer encoder with expanded multi-head self-attention\nUse the original post-norm encoder: Input tokens → Token embedding, added to Positional encoding, then an N× encoder stack. Bottom to top inside the layer: Multi-head self-attention → Add & Norm → Feed-forward → Add & Norm; Output embeddings are outside above it. The first residual bypasses attention from its input into the first Add & Norm; the second bypasses Feed-forward into the second Add & Norm.\nA separate Attention detail inset connects by an undirected leader. The same input projects to Q, K and V. Q and K → QKᵀ / √dₖ → Softmax; Softmax and V → Weighted sum; multiple heads → Concat → Output projection.\nUse stacked matrices with horizontal labels. The inset is not an extra data-flow cycle. Do not substitute pre-norm, decoder cross-attention, a causal mask or a task head. Do not invent fixed layers, heads or tensor dimensions.",
    ], sources: [{ title: "Vaswani et al.: Attention Is All You Need (2017)", url: "https://arxiv.org/abs/1706.03762" }],
  },
  narrative: {
    id: "research_agents", family: "narrative", discipline: ["研究智能体", "Research agents"], title: ["研究执行与独立审查", "Research & independent review"], features: ["规划与工具 · 证据流 · 审查反馈", "Planning/tools · evidence · review feedback"],
    description: [
      "研究智能体的执行与独立审查工作流\n规划层：Research question → Literature evidence → Experiment plan。执行层：实验计划 → Executor → Tools & data → Results。审查层：Results 与 Experiment plan 作为两个独立输入进入 Independent Reviewer；Pass 分支输出 Accepted artifacts，Revise 分支用虚线反馈到 Executor。\nLocal project memory 用细的无方向上下文连接关联规划与执行，不能误画成自动生成科学结论的信号箭头。\n用文档、代码、工具与证据图标表示对象；Executor 与 Reviewer 是两个不同角色。结果图标是文件示意，不编造实验曲线、数值或已经完成的研究结果。",
      "Research agents with execution and independent review\nPlanning tier: Research question → Literature evidence → Experiment plan. Execution tier: plan → Executor → Tools & data → Results. Review tier: Results and Experiment plan separately enter Independent Reviewer. Pass leads to Accepted artifacts; a dashed Revise feedback ends at Executor.\nLocal project memory has thin undirected context links to planning and execution, not scientific-result arrows.\nUse coherent document, code, tool and evidence icons. Executor and Reviewer remain distinct roles. Result icons represent files, not fabricated plots, measurements or completed experiments.",
    ], sources: [],
  },
  illustration: {
    id: "mapk", family: "illustration", discipline: ["生物化学", "Biochemistry"], title: ["EGFR–MAPK 信号通路", "EGFR–MAPK signaling"], features: ["膜与细胞核 · 磷酸化 · 抑制反馈", "Membrane/nucleus · phosphorylation · inhibition"],
    description: [
      "EGF–EGFR–RAS–RAF–MEK–ERK 信号通路示意\n画细胞外、脂质双层、细胞质和细胞核四个空间层次。EGF 在细胞外结合跨膜 EGFR 二聚体，受体胞内端标出磷酸化位点示意；EGFR 招募 Grb2 和 SOS。SOS 促进膜内侧 RAS 的 GDP/GTP 交换，区分 RAS–GDP 与 RAS–GTP，不把 RAS 激活误标为磷酸化。\nRAS–GTP 激活 RAF；RAF → MEK → ERK 为激酶级联，后两步标明磷酸化。激活 ERK 进入细胞核作用于 Transcription factors，再关联 Gene expression。\n选择性展示 ERK 对 SOS 的负反馈：虚线抑制连接以 T 形末端终止于 SOS，不能用正常激活箭头。蛋白轮廓、注释引线与反应连接分开。本图是简化机制示意，不按分子尺度绘制，不加入药物、突变、真实位点编号、治疗效果或未提供的实验数据。",
      "Simplified EGF–EGFR–RAS–RAF–MEK–ERK signaling\nSeparate extracellular space, lipid bilayer, cytoplasm and nucleus. EGF binds a transmembrane EGFR dimer with illustrative intracellular phosphorylation marks. EGFR recruits Grb2 and SOS. SOS promotes membrane-associated RAS GDP/GTP exchange; distinguish RAS–GDP and RAS–GTP and do not label RAS activation as phosphorylation.\nRAS–GTP activates RAF; RAF → MEK → ERK is the kinase cascade, with phosphorylation indicated for the latter two steps. Activated ERK enters the nucleus, acts on Transcription factors and connects to Gene expression.\nShow one selected ERK-to-SOS negative feedback as a dashed inhibition connection ending in a T-bar at SOS, never an activation arrowhead. Distinguish protein contours, annotation leaders and reaction edges. This simplified mechanism is not to molecular scale. Do not add drugs, mutations, residue numbers, treatment outcomes or experimental data.",
    ], sources: [
      { title: "Kocieniewski & Lipniacki: MAPK/ERK system regulation (2026)", url: "https://doi.org/10.1038/s41598-026-44353-3" },
      { title: "ERK pathway mechanisms (2024)", url: "https://www.nature.com/articles/s41698-024-00554-5" },
    ],
  },
};
