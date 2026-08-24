import { useState } from "react";
import type { Copy } from "../i18n";

type Props = { copy: Copy };

/**
 * 1:1 Exact Pixel-Perfect Recreation of SomniQ Studio / SomniQ Chat Desktop Application.
 * Matches the real software UI in media_1787300675929.png down to every button, sidebar,
 * starter cards, and bottom composer.
 */
export default function AppMock({ copy }: Props) {
  const isZh = copy.htmlLang === "zh-CN";

  // Active view: null for Welcome view (default screenshot view) or session ID / text for chat stream
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("MiniMax-M3");
  const [isCriticActive, setIsCriticActive] = useState<boolean>(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("p1");

  // High-level scientific research demo projects with clean simulated data
  const projectDefs = [
    {
      id: "p1",
      name: isZh ? "SE(3) 等变扩散机制" : "SE(3)-Equivariant-Diffusion",
      path: isZh ? "D:\\Autonomous-Lab\\SE3-Equivariant-Diffusion" : "D:\\Autonomous-Lab\\SE3-Equivariant-Diffusion",
      count: 36,
      item: {
        id: "p1_item",
        name: isZh ? "几何扩散网络架构推导" : "Geometric Diffusion Architecture",
        query: isZh
          ? "针对几何扩散网络架构推导，梳理 SE(3) 李群流形扩散与等变旋转算子的数学表达图示。"
          : "Outline mathematical diagrams for SE(3) Lie group manifold diffusion and equivariant rotation operators.",
      },
    },
    {
      id: "p2",
      name: isZh ? "海上新能源拓扑预测" : "Offshore-Energy-Forecasting",
      path: isZh ? "D:\\Research-Projects\\Offshore-Turbine-Topology" : "D:\\Research-Projects\\Offshore-Turbine-Topology",
      count: 64,
      item: {
        id: "p2_item",
        name: isZh ? "高维时序动态拓扑图" : "Dynamic Spatio-Temporal Graph",
        query: isZh
          ? "生成并美化海上风力机组的动态时序预测与物理拓扑图。"
          : "Generate and refine physical topology diagrams for offshore wind turbine spatio-temporal forecasting.",
      },
    },
    {
      id: "p3",
      name: "autonomous-lab-pipeline",
      path: isZh ? "D:\\Workspace\\Autonomous-Lab" : "D:\\Workspace\\Autonomous-Lab",
      count: 18,
      item: {
        id: "p3_item",
        name: isZh ? "自主实验闭环自动化流" : "Autonomous Closed-Loop Pipeline",
        query: isZh
          ? "配置 Jupyter、Python 与 MATLAB 联合实验环境及参数调优自动化流。"
          : "Configure Jupyter, Python and MATLAB joint experimentation environment with auto-tuning flows.",
      },
    },
  ];

  const activeProject = projectDefs.find((p) => p.id === selectedProjectId) || projectDefs[0];

  const starters = [
    {
      id: "literature",
      label: isZh ? "文献检索" : "Literature Search",
      hint: isZh ? "激发近年论文，梳理研究脉络" : "Find recent papers & map the field",
      iconBg: "rgba(56, 189, 248, 0.15)",
      iconColor: "#38bdf8",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      ),
      query: isZh
        ? "围绕课题「文献检索」，检索近两年前沿文献并对比 SE(3) 等变扩散机制与实验采样收敛速度。"
        : "Retrieve recent SOTA literature on SE(3) equivariant diffusion mechanisms and benchmark sampling convergence speeds.",
    },
    {
      id: "research",
      label: isZh ? "资料搜集" : "Data Collection",
      hint: isZh ? "汇总资料、数据与可靠来源" : "Aggregate datasets, sources & benchmarks",
      iconBg: "rgba(34, 197, 94, 0.15)",
      iconColor: "#4ade80",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h16M4 12h16M4 18h10" />
          <path d="M18 15v6M15 18h6" />
        </svg>
      ),
      query: isZh
        ? "围绕课题「资料搜集」，汇总蛋白质结构预测的核心 PDB 基准数据集及标准化预处理流水线。"
        : "Aggregate core PDB benchmark datasets and standardized preprocessing pipelines for structural biology.",
    },
    {
      id: "review",
      label: isZh ? "论文审查" : "Paper Review",
      hint: isZh ? "检查逻辑、方法与表达" : "Audit methodology, derivations & logic",
      iconBg: "rgba(245, 158, 11, 0.15)",
      iconColor: "#f59e0b",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      ),
      query: isZh
        ? "围绕课题「论文审查」，对当前章节进行双模型独立审查，排查数学推导漏洞与引用幻觉。"
        : "Perform dual-agent independent audit on current draft to detect mathematical flaws and citation hallucinations.",
    },
    {
      id: "writing",
      label: isZh ? "论文写作" : "Paper Writing",
      hint: isZh ? "搭建结构并完善关键段落" : "Draft sections & compile Overleaf-grade LaTeX",
      iconBg: "rgba(168, 85, 247, 0.15)",
      iconColor: "#c084fc",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      ),
      query: isZh
        ? "围绕课题「论文写作」，基于实验数据起草 LaTeX 格式的方法论与讨论章节。"
        : "Draft Overleaf-grade LaTeX methodology and discussion sections grounded in recent experimental results.",
    },
  ];

  // Resolve active session title and user query dynamically based on current language
  let activeTitle = "";
  let activeUserQuery = "";

  if (activeSessionId) {
    const starterMatch = starters.find((s) => s.id === activeSessionId);
    if (starterMatch) {
      activeTitle = starterMatch.label;
      activeUserQuery = starterMatch.query;
    } else {
      const projItemMatch = projectDefs.find((p) => p.item.id === activeSessionId);
      if (projItemMatch) {
        activeTitle = projItemMatch.item.name;
        activeUserQuery = projItemMatch.item.query;
      } else {
        activeTitle = activeSessionId;
        activeUserQuery = activeSessionId;
      }
    }
  }

  return (
    <div className="sq-desktop" aria-label="SomniQ Studio Desktop Application Interface">
      {/* ── 1. Top Window Header Bar ──────────────────────────────────────── */}
      <header className="sq-topbar">
        <div className="sq-topbar-left">
          <button type="button" className="sq-tb-btn" title={isZh ? "折叠/展开侧边栏" : "Toggle Sidebar"}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <button type="button" className="sq-tb-btn" title={isZh ? "搜索" : "Search"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
          <button type="button" className="sq-tb-btn" title={isZh ? "返回" : "Back"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button type="button" className="sq-tb-btn" title={isZh ? "前进" : "Forward"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>

        {/* Center Project Bar */}
        <div className="sq-topbar-center">
          <div className="sq-proj-pill" onClick={() => setSelectedProjectId((prev) => (prev === "p1" ? "p2" : "p1"))}>
            <span className="sq-proj-name">{activeProject.name}</span>
            <span className="sq-proj-caret">ˇ</span>
          </div>
          <button type="button" className="sq-proj-add-btn">+ {isZh ? "添加" : "Add"}</button>
          <span className="sq-proj-path">{activeProject.path}</span>
          <span className="sq-proj-folder" title={isZh ? "打开项目文件夹" : "Open Folder"}>📁</span>
        </div>

        {/* Right Window Actions & Controls */}
        <div className="sq-topbar-right">
          <div className="sq-token-pill" title={isZh ? "当前计算额度" : "Active Compute Credit"}>
            <span className="sq-token-diamond">✦</span>
            <span className="sq-token-val">1</span>
          </div>
          <button type="button" className="sq-tb-btn" title={isZh ? "导出记录" : "Export Chat"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          </button>
          <button type="button" className="sq-tb-btn" title={isZh ? "清空屏幕" : "Clear Screen"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
          <button type="button" className="sq-tb-btn" title={isZh ? "分屏视图" : "Split View"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M12 3v18" />
            </svg>
          </button>

          {/* Native Window Controls */}
          <div className="sq-window-controls">
            <button type="button" className="sq-win-btn sq-win-min" title={isZh ? "最小化" : "Minimize"}>─</button>
            <button type="button" className="sq-win-btn sq-win-max" title={isZh ? "最大化" : "Maximize"}>□</button>
            <button type="button" className="sq-win-btn sq-win-close" title={isZh ? "关闭" : "Close"}>✕</button>
          </div>
        </div>
      </header>

      {/* ── 2. Main Desktop Shell (Sidebar + Center Content) ──────────────── */}
      <div className="sq-shell-body">
        {/* Left App Sidebar */}
        <aside className="sq-sidebar">
          {/* SomniQ Chat Header dropdown */}
          <div className="sq-sb-head">
            <span className="sq-sb-logo-title">SomniQ Chat</span>
            <span className="sq-sb-caret">ˇ</span>
          </div>

          {/* Top Actions */}
          <div className="sq-sb-actions">
            <button type="button" className="sq-sb-btn-machine">
              <span className="sq-plus-icon">+</span>
              <span>{isZh ? "本机 本机项目" : "Local Workspace"}</span>
              <span className="sq-sb-caret-sm">ˇ</span>
            </button>

            <button
              type="button"
              className="sq-sb-btn-newchat"
              onClick={() => setActiveSessionId(null)}
            >
              <span className="sq-plus-icon">+</span>
              <span>{isZh ? "新对话" : "New Chat"}</span>
            </button>

            <button type="button" className="sq-sb-btn-tasks">
              <span className="sq-bolt-icon">⚡</span>
              <span>{isZh ? "定时任务" : "Scheduled Tasks"}</span>
            </button>
          </div>

          {/* Section: 本机项目 */}
          <div className="sq-sb-section">
            <div className="sq-sb-sec-title">{isZh ? "本机项目" : "LOCAL PROJECTS"}</div>

            {/* Folder 1 */}
            <div className="sq-sb-folder">
              <div
                className={`sq-sb-folder-head ${selectedProjectId === "p1" ? "active" : ""}`}
                onClick={() => setSelectedProjectId("p1")}
              >
                <span className="sq-sb-folder-icon">🗂</span>
                <span className="sq-sb-folder-name">{projectDefs[0].name}</span>
                <span className="sq-sb-folder-add">+</span>
              </div>
              <ul className="sq-sb-item-list">
                <li
                  className={`sq-sb-item ${activeSessionId === projectDefs[0].item.id ? "sq-sb-item--active" : ""}`}
                  onClick={() => {
                    setSelectedProjectId("p1");
                    setActiveSessionId(projectDefs[0].item.id);
                  }}
                >
                  {projectDefs[0].item.name}
                </li>
              </ul>
              <button type="button" className="sq-sb-expand-btn">
                {isZh ? `展开显示 (${projectDefs[0].count})` : `Show all (${projectDefs[0].count})`}
              </button>
            </div>

            {/* Folder 2 */}
            <div className="sq-sb-folder">
              <div
                className={`sq-sb-folder-head ${selectedProjectId === "p2" ? "active" : ""}`}
                onClick={() => setSelectedProjectId("p2")}
              >
                <span className="sq-sb-folder-icon">🗂</span>
                <span className="sq-sb-folder-name">{projectDefs[1].name}</span>
                <span className="sq-sb-folder-add">+</span>
              </div>
              <ul className="sq-sb-item-list">
                <li
                  className={`sq-sb-item ${activeSessionId === projectDefs[1].item.id ? "sq-sb-item--active" : ""}`}
                  onClick={() => {
                    setSelectedProjectId("p2");
                    setActiveSessionId(projectDefs[1].item.id);
                  }}
                >
                  {projectDefs[1].item.name}
                </li>
              </ul>
              <button type="button" className="sq-sb-expand-btn">
                {isZh ? `展开显示 (${projectDefs[1].count})` : `Show all (${projectDefs[1].count})`}
              </button>
            </div>

            {/* Folder 3 */}
            <div className="sq-sb-folder">
              <div
                className={`sq-sb-folder-head ${selectedProjectId === "p3" ? "active" : ""}`}
                onClick={() => setSelectedProjectId("p3")}
              >
                <span className="sq-sb-folder-icon">🗂</span>
                <span className="sq-sb-folder-name">{projectDefs[2].name}</span>
                <span className="sq-sb-folder-add">+</span>
              </div>
              <ul className="sq-sb-item-list">
                <li
                  className={`sq-sb-item ${activeSessionId === projectDefs[2].item.id ? "sq-sb-item--active" : ""}`}
                  onClick={() => {
                    setSelectedProjectId("p3");
                    setActiveSessionId(projectDefs[2].item.id);
                  }}
                >
                  {projectDefs[2].item.name}
                </li>
              </ul>
            </div>
          </div>

          {/* Sidebar Bottom Profile */}
          <div className="sq-sb-footer">
            <div className="sq-user-avatar">DR</div>
            <div className="sq-user-info">
              <span className="sq-user-name">{isZh ? "林博士 · 独立研究员" : "Dr. Alex Lin (Fellow)"}</span>
              <span className="sq-user-balance">{isZh ? "算力余额 $128.50" : "Balance $128.50"}</span>
            </div>
            <span className="sq-user-chevron">›</span>
          </div>
        </aside>

        {/* ── 3. Center Main Workspace Area ───────────────────────────────── */}
        <main className="sq-main-stage">
          {activeSessionId === null ? (
            /* ── A: Exact Welcome View from media_1787300675929.png ──────── */
            <div className="sq-welcome-view">
              <div className="sq-welcome-center">
                {/* Glowing App Mark Icon */}
                <div className="sq-app-icon-wrap">
                  <div className="sq-app-icon-glow" aria-hidden="true" />
                  <img src="./app-logo.png" alt="SomniQ Logo" className="sq-app-logo-img" width={68} height={68} />
                </div>

                {/* Main Hero Slogan */}
                <h1 className="sq-welcome-title">
                  {isZh ? (
                    <>
                      <span>梦中</span>
                      <span className="sq-hl-cyan">求索</span>
                      <span>，醒时</span>
                      <span className="sq-hl-purple">有获</span>
                    </>
                  ) : (
                    <>
                      <span>Seek in </span>
                      <span className="sq-hl-cyan">Dreams</span>
                      <span>, harvest on </span>
                      <span className="sq-hl-purple">waking</span>
                    </>
                  )}
                </h1>

                {/* Subtitle */}
                <p className="sq-welcome-desc">
                  {isZh
                    ? "SomniQ 在后台持续推理、检索、分析与生成，把问题推进成答案。"
                    : "SomniQ continuously reasons, retrieves, analyzes, and drafts in the background, turning questions into verified breakthroughs."}
                </p>

                {/* 4 Feature Quick-Start Cards (2x2 Grid) */}
                <div className="sq-starters-grid">
                  {starters.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="sq-starter-card"
                      onClick={() => setActiveSessionId(s.id)}
                    >
                      <div
                        className="sq-starter-icon"
                        style={{ background: s.iconBg, color: s.iconColor }}
                      >
                        {s.icon}
                      </div>
                      <div className="sq-starter-info">
                        <strong className="sq-starter-title">{s.label}</strong>
                        <span className="sq-starter-hint">{s.hint}</span>
                      </div>
                      <span className="sq-starter-arrow">›</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* ── B: Active Live Research Dialogue & Reviewer Stream ──────── */
            <div className="sq-chat-active-view">
              <div className="sq-chat-session-header">
                <div className="sq-chat-session-info">
                  <strong>💬 {activeTitle}</strong>
                  <span>{isZh ? `基于 ${activeProject.name} 课题上下文` : `Context: ${activeProject.name}`}</span>
                </div>
                <button
                  type="button"
                  className="sq-back-btn"
                  onClick={() => setActiveSessionId(null)}
                >
                  {isZh ? "← 返回新对话" : "← New Chat"}
                </button>
              </div>

              <div className="sq-turns-stream">
                {/* User message */}
                <div className="sq-msg sq-msg--user">
                  <div className="sq-msg-avatar sq-msg-avatar--user">DR</div>
                  <div className="sq-msg-bubble">
                    <p>{activeUserQuery}</p>
                  </div>
                </div>

                {/* Agent Tool & Draft */}
                <div className="sq-msg sq-msg--assistant">
                  <div className="sq-msg-avatar sq-msg-avatar--ai">SQ</div>
                  <div className="sq-msg-bubble">
                    {/* Tool Pill */}
                    <div className="sq-tool-status">
                      <span>⚡ {isZh ? "自动执行 lit_search(query='SE3 equivariant diffusion') · 命中 41 篇文献" : "Executed lit_search(query='SE3 equivariant diffusion') · 41 papers indexed"}</span>
                      <span className="sq-tool-ok">{isZh ? "✓ 已通过索引" : "✓ Indexed"}</span>
                    </div>

                    <p>
                      {isZh
                        ? "已为您从 Scopus 与 arXiv 数据库中提取并对比了 3 篇核心代表作："
                        : "Extracted and compared 3 core milestone papers from Scopus and arXiv databases:"}
                    </p>

                    <div className="sq-mini-papers">
                      <div className="sq-paper-chip">
                        <span className="sq-paper-tag">Nature 2023 · Scopus</span>
                        <strong>RFdiffusion (Watson et al.)</strong>
                        <p>{isZh ? "基于 RoseTTAFold 的刚体坐标扩散，支持 Motif 锚定生成" : "RoseTTAFold-based rigid body coordinate diffusion with motif scaffolding"}</p>
                      </div>
                      <div className="sq-paper-chip">
                        <span className="sq-paper-tag">bioRxiv 2023 · arXiv</span>
                        <strong>Chroma (Ingraham et al.)</strong>
                        <p>{isZh ? "全原子三维流形扩散，支持高阶点群对称性约束" : "All-atom 3D manifold diffusion with high-order point group symmetry"}</p>
                      </div>
                      <div className="sq-paper-chip">
                        <span className="sq-paper-tag">ICML 2024 · Spotlight</span>
                        <strong>FoldFlow (Bose et al.)</strong>
                        <p>{isZh ? "黎曼流匹配 (Riemannian Flow Matching)，采样加速 10x" : "Riemannian Flow Matching with 10x generation speedup"}</p>
                      </div>
                    </div>

                    {/* Reviewer Audit Card */}
                    <div className="sq-reviewer-banner">
                      <div className="sq-rev-top">
                        <span className="sq-rev-shield">🛡️</span>
                        <strong>{isZh ? "把关 Agent (GPT-4o 独立审查)" : "Reviewer Agent (GPT-4o Independent Audit)"}</strong>
                        <span className="sq-rev-badge">✓ {isZh ? "16步审查通过 (Pass: 96.2%)" : "16-Step Audit Pass (96.2%)"}</span>
                      </div>
                      <p className="sq-rev-detail">
                        {isZh
                          ? "✓ 3 篇论文 DOI 与引用链接均完成本地校验；SE(3) 李群刚体几何变换表述严谨，无幻觉生成。"
                          : "✓ Verified 3 paper DOIs and citation links locally; Lie group SE(3) rigid geometric transformations verified with zero hallucinations."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── 4. Bottom Message Composer (Exact from screenshot) ──────────── */}
          <div className="sq-composer-container">
            <div className="sq-composer-box">
              <input
                type="text"
                className="sq-composer-input"
                placeholder={isZh ? "给 SomniQ 发送消息" : "Send a message to SomniQ..."}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value) {
                    setActiveSessionId(e.currentTarget.value);
                    e.currentTarget.value = "";
                  }
                }}
              />

              <div className="sq-composer-toolbar">
                {/* Left Controls */}
                <div className="sq-comp-left">
                  <button
                    type="button"
                    className={`sq-critic-btn ${isCriticActive ? "sq-critic-btn--active" : ""}`}
                    onClick={() => setIsCriticActive(!isCriticActive)}
                  >
                    <span>{isZh ? "自动批评" : "Auto-Review"}</span>
                    <span className="sq-comp-caret">ˇ</span>
                  </button>

                  <button type="button" className="sq-attach-btn" title={isZh ? "添加附件" : "Add Attachment"}>
                    +
                  </button>
                </div>

                {/* Right Controls */}
                <div className="sq-comp-right">
                  <div className="sq-percent-pill" title={isZh ? "上下文预算" : "Context Token Budget"}>
                    <span className="sq-percent-ring">⭕</span>
                    <span className="sq-percent-text">0%</span>
                  </div>

                  <div className="sq-model-selector">
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="sq-model-select"
                    >
                      <option value="MiniMax-M3">MiniMax-M3</option>
                      <option value="DeepSeek-V4Flash">DeepSeek V4Flash</option>
                      <option value="Codex-GPT">Codex · GPT</option>
                    </select>
                    <span className="sq-model-caret">ˇ</span>
                  </div>

                  <button
                    type="button"
                    className="sq-send-btn"
                    onClick={() => setActiveSessionId("literature")}
                    title={isZh ? "发送" : "Send"}
                  >
                    ➤
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

