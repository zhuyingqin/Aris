import { useState } from "react";
import type { Copy } from "../i18n";
import Section from "./Section";
import {
  CheckIcon,
  HandshakeIcon,
  NetworkIcon,
  SparklesIcon,
} from "./icons";

type Props = { copy: Copy };

export default function Assist({ copy }: Props) {
  const { assist } = copy;
  const { topology } = assist;
  const [isDelivered, setIsDelivered] = useState<boolean>(true);
  const [selectedPeerIdx, setSelectedPeerIdx] = useState<number>(0);

  return (
    <Section
      id="assist"
      kicker={assist.kicker}
      title={assist.title}
      lede={assist.lede}
      tone="raised"
    >
      {/* ── Visual Storyboard: 论文缺图 ➔ 全网同行互助圈 ➔ 同行电脑代画 ➔ 自动回传 ── */}
      <div className="assist-storyboard-card" data-reveal>
        {/* Top bar with title and active network status */}
        <div className="storyboard-top-bar">
          <div className="storyboard-title-group">
            <span className="storyboard-badge">
              <NetworkIcon width={14} height={14} />
              {topology.userRingBadge}
            </span>
            <strong className="storyboard-headline">{topology.userRingTitle}</strong>
          </div>
          <div className="storyboard-online-pill">
            <span className="storyboard-live-pulse" />
            <span>{topology.onlineBadge}</span>
          </div>
        </div>

        {/* ── 3-Stage Visual Story Canvas ── */}
        <div className="storyboard-canvas">
          {/* 1. Left Stage: Your Computer (Paper Workspace) */}
          <div className="storyboard-stage-card storyboard-stage-card--requester">
            <div className="stage-card-header">
              <div className="stage-window-dots">
                <span className="dot-red" />
                <span className="dot-amber" />
                <span className="dot-green" />
              </div>
              <span className="stage-file-title">📄 {topology.leftCard.docName}</span>
              <span className="stage-tag-badge">{topology.leftCard.tag}</span>
            </div>

            <div className="stage-card-body">
              <div className="latex-editor-preview">
                <div className="latex-line"><span className="latex-ln">1</span><span className="latex-kw">\section</span>{`{Model Architecture}`}</div>
                <div className="latex-line"><span className="latex-ln">2</span><span className="latex-kw">\begin</span>{`{figure}[htbp]`}</div>
                <div className="latex-line latex-line--indent"><span className="latex-ln">3</span><span className="latex-kw">\centering</span></div>

                {/* The Figure Slot in LaTeX: Empty or Delivered */}
                <div
                  className={`latex-figure-slot${isDelivered ? " is-slotted" : " is-empty"}`}
                  onClick={() => setIsDelivered(!isDelivered)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setIsDelivered(!isDelivered); }}
                  title="点击切换互助前后效果"
                >
                  {isDelivered ? (
                    <div className="slotted-figure-preview">
                      <div className="slotted-badge">
                        <CheckIcon width={12} height={12} />
                        <span>已自动插入论文 (4K SVG)</span>
                      </div>
                      {/* Mini Neural Diagram Graphic */}
                      <svg viewBox="0 0 200 70" className="mini-paper-chart" aria-label="Transformer Architecture diagram">
                        <rect x="8" y="18" width="42" height="34" rx="4" fill="rgba(56, 189, 248, 0.2)" stroke="#38bdf8" strokeWidth="1.5" />
                        <text x="29" y="39" fill="#0284c7" className="svg-text-primary" fontSize="8" fontWeight="bold" textAnchor="middle">Input</text>

                        <path d="M 50 35 L 68 35" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="2 2" />

                        <rect x="68" y="10" width="64" height="50" rx="6" fill="rgba(168, 85, 247, 0.2)" stroke="#a855f7" strokeWidth="1.5" />
                        <text x="100" y="30" fill="#7e22ce" className="svg-text-purple" fontSize="7.5" fontWeight="bold" textAnchor="middle">Multi-Head</text>
                        <text x="100" y="44" fill="#a855f7" className="svg-text-purple-sub" fontSize="6.5" textAnchor="middle">Attention (8x)</text>

                        <path d="M 132 35 L 150 35" stroke="#16a34a" strokeWidth="1.5" />

                        <rect x="150" y="18" width="42" height="34" rx="4" fill="rgba(52, 211, 153, 0.2)" stroke="#34d399" strokeWidth="1.5" />
                        <text x="171" y="39" fill="#16a34a" className="svg-text-green" fontSize="8" fontWeight="bold" textAnchor="middle">Output</text>
                      </svg>
                    </div>
                  ) : (
                    <div className="empty-placeholder-box">
                      <span className="empty-icon">🖼️</span>
                      <strong className="empty-title">{topology.leftCard.missingBoxText}</strong>
                      <span className="empty-sub">缺少生图账号 · 点击发往互助圈</span>
                    </div>
                  )}
                </div>

                <div className="latex-line"><span className="latex-ln">4</span><span className="latex-kw">\caption</span>{`{Transformer Architecture}`}</div>
                <div className="latex-line"><span className="latex-ln">5</span><span className="latex-kw">\end</span>{`{figure}`}</div>
              </div>

              <button
                type="button"
                className={`stage-action-trigger${isDelivered ? " is-active" : ""}`}
                onClick={() => setIsDelivered(!isDelivered)}
              >
                <SparklesIcon width={14} height={14} />
                <span>{isDelivered ? "✓ 互助构图已完成 (点击重演)" : topology.leftCard.actionBtn}</span>
              </button>
            </div>
          </div>

          {/* 2. Center Stage: Global Peer Circle & Information Interaction Canvas */}
          <div className="storyboard-stage-card storyboard-stage-card--network">
            {/* Ambient Dynamic Radar & Communication Waves */}
            <div className="network-orbit-backdrop" aria-hidden="true">
              <div className="orbit-circle orbit-circle--outer" />
              <div className="orbit-circle orbit-circle--inner" />
              <div className="orbit-radar-sweep" />
            </div>

            {/* Central Broker Hub */}
            <div className="network-center-hub">
              <div className="center-hub-icon-wrap">
                <HandshakeIcon width={24} height={24} />
              </div>
              <strong className="center-hub-title">{topology.centerHub.title}</strong>
              <span className="center-hub-desc">{topology.centerHub.desc}</span>

              {/* Dynamic Task Broadcast Badge */}
              <div className="traveling-task-packet">
                <span className="packet-spark">⚡</span>
                <span className="packet-text">{topology.centerHub.packetLabel}</span>
              </div>
            </div>

            {/* Expanded Prominent Peer Researcher Grid / Interaction Arena */}
            <div className="network-peer-arena">
              {topology.peers.map((p, idx) => {
                const isSelected = idx === selectedPeerIdx;
                const isAlex = idx === 0;
                return (
                  <div
                    key={p.name}
                    className={`peer-interactive-card peer-card--${idx}${isAlex ? " is-matched-active" : ""}${isSelected ? " is-selected" : ""}`}
                    onClick={() => setSelectedPeerIdx(idx)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setSelectedPeerIdx(idx); }}
                  >
                    <div className="peer-card-top">
                      <div className="peer-avatar-wrapper">
                        <span className="peer-avatar-emoji">
                          {idx === 0 ? "🧑‍🔬" : idx === 1 ? "👩‍💻" : idx === 2 ? "👨‍🔬" : "👩‍🏫"}
                        </span>
                        <span className={`peer-live-dot${isAlex ? " is-active-green" : ""}`} />
                      </div>
                      <div className="peer-title-info">
                        <strong className="peer-name">{p.name}</strong>
                        <span className={`peer-status-tag${isAlex ? " tag-accepted" : ""}`}>{p.loc}</span>
                      </div>
                    </div>

                    {/* Live Interaction Dialogue Bubble */}
                    <div className="peer-msg-bubble">
                      {isAlex ? (
                        <span className="peer-speech-text">
                          <span className="typing-dots"><span>.</span><span>.</span><span>.</span></span>
                          已接单！正调用模型绘制 4K 架构图
                        </span>
                      ) : idx === 1 ? (
                        <span className="peer-speech-text">待命：文献分析提取就绪</span>
                      ) : idx === 2 ? (
                        <span className="peer-speech-text">待命：TikZ 矢量转换就绪</span>
                      ) : (
                        <span className="peer-speech-text">待命：LaTeX 排版对齐就绪</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. Right Stage: Peer's Computer (Volunteer Rendering Sandbox) */}
          <div className="storyboard-stage-card storyboard-stage-card--helper">
            <div className="stage-card-header stage-card-header--green">
              <div className="stage-window-dots">
                <span className="dot-red" />
                <span className="dot-amber" />
                <span className="dot-green" />
              </div>
              <span className="stage-file-title">🎨 {topology.rightCard.helperBadge}</span>
              <span className="stage-tag-badge stage-tag-badge--green">{topology.rightCard.tag}</span>
            </div>

            <div className="stage-card-body">
              {/* High-res Rendered Neural Architecture Canvas */}
              <div className="helper-canvas-preview">
                <div className="canvas-header-bar">
                  <span className="canvas-title">AI Studio (Sandbox)</span>
                  <span className="canvas-badge-done">{topology.rightCard.doneBadge}</span>
                </div>

                {/* Illustrated Detailed Scientific Figure */}
                <div className="scientific-figure-box">
                  <svg viewBox="0 0 240 130" className="scientific-svg-render" aria-label="Scientific neural diagram">
                    <defs>
                      <linearGradient id="grad-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#0284c7" stopOpacity="0.85" />
                      </linearGradient>
                      <linearGradient id="grad-purple" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#c084fc" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#7e22ce" stopOpacity="0.85" />
                      </linearGradient>
                      <linearGradient id="grad-green" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#4ade80" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#15803d" stopOpacity="0.85" />
                      </linearGradient>
                    </defs>

                    {/* Background grid */}
                    <pattern id="archgrid" width="12" height="12" patternUnits="userSpaceOnUse">
                      <path d="M 12 0 L 0 0 0 12" fill="none" stroke="currentColor" strokeWidth="0.5" strokeOpacity="0.08" />
                    </pattern>
                    <rect width="240" height="130" fill="url(#archgrid)" rx="6" />

                    {/* Architecture Nodes */}
                    <g transform="translate(10, 15)">
                      {/* Embedding Block */}
                      <rect x="0" y="75" width="46" height="26" rx="4" fill="url(#grad-cyan)" stroke="#38bdf8" strokeWidth="1" />
                      <text x="23" y="91" fill="#fff" fontSize="7.5" fontWeight="bold" textAnchor="middle">Embedding</text>

                      {/* Line to Attention */}
                      <path d="M 46 88 L 66 88 L 66 50 L 76 50" fill="none" stroke="#38bdf8" strokeWidth="1.5" />

                      {/* Multi-Head Attention Block */}
                      <rect x="76" y="24" width="72" height="48" rx="6" fill="url(#grad-purple)" stroke="#a855f7" strokeWidth="1" />
                      <text x="112" y="44" fill="#fff" fontSize="8.5" fontWeight="bold" textAnchor="middle">Multi-Head</text>
                      <text x="112" y="58" fill="#e9d5ff" fontSize="7.5" textAnchor="middle">Attention (8x)</text>

                      {/* Residual Skip Connection */}
                      <path d="M 66 88 L 66 102 L 158 102 L 158 50 L 168 50" fill="none" stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="3 2" />
                      <text x="112" y="98" fill="#fbbf24" fontSize="6" textAnchor="middle">Residual Add & Norm</text>

                      {/* Line to FeedForward */}
                      <path d="M 148 48 L 168 48" fill="none" stroke="#c084fc" strokeWidth="1.5" />

                      {/* Feed Forward Block */}
                      <rect x="168" y="24" width="52" height="48" rx="6" fill="url(#grad-green)" stroke="#4ade80" strokeWidth="1" />
                      <text x="194" y="44" fill="#fff" fontSize="8" fontWeight="bold" textAnchor="middle">Feed</text>
                      <text x="194" y="58" fill="#bbf7d0" fontSize="7.5" textAnchor="middle">Forward</text>
                    </g>
                  </svg>
                </div>

                <div className="helper-status-row">
                  <span className="helper-sandbox-dot" />
                  <span className="helper-status-text">{topology.rightCard.statusText}</span>
                </div>
              </div>

              <div className="helper-return-action">
                <span className="return-pulse-line" />
                <span>{topology.rightCard.returnAction}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── 4-Step Storyboard Progression Footer ── */}
        <div className="storyboard-flow-steps">
          {topology.flowSteps.map((fs, idx) => (
            <div key={fs.step} className={`story-step-card story-step-card--${idx}`}>
              <div className="story-step-header">
                <span className="story-step-badge">0{idx + 1}</span>
                <strong className="story-step-title">{fs.title}</strong>
              </div>
              <p className="story-step-desc">{fs.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
