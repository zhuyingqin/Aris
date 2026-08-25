import { Fragment, memo, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatBlock, ChatTurn } from "../types";
import { chatChangeRevert } from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import ChatImagePreview, { isDirectImageSource } from "./ChatImagePreview";
import MarkdownContent, { ThinkBlock, type MarkdownEvidenceSource } from "./MarkdownContent";
import IndependentReviewBadge from "./IndependentReviewBadge";
import { CHAT_COPY } from "./i18n";
import { textFromTurn } from "./model";
import { useStore } from "../store";
import { useOpenChatFile } from "./openChatFile";
import { displayLocalFilePath } from "./localFileLinks";
import {
  diffFromTool,
  evidenceSearchSummaryFromTool,
  evidenceSourcesFromTool,
  formatCount,
  imagePathsFromTool,
  oracleWebSummaryFromTool,
  webSearchSummaryFromTool,
  type ChatToolBlock,
  type TurnFileChangeSummary,
  type TurnFileSummary,
} from "./toolSummaries";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? copy.copied : copy.copy}
    </button>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function ToolProgressView({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const progress = block.progress;
  if (!progress || block.output !== undefined) return null;
  const hasTail = Boolean(progress.stdoutTail || progress.stderrTail);
  const timeout = progress.timeoutMs ? ` / ${formatElapsed(progress.timeoutMs)}` : "";
  return (
    <div className={`chat-tool-progress${progress.nearTimeout ? " near-timeout" : ""}`}>
      <div className="chat-tool-progress-line">
        <span>{progress.message || "Still running"}</span>
        <span>{formatElapsed(progress.elapsedMs)}{timeout}</span>
        {progress.pid != null && <span>PID {progress.pid}</span>}
      </div>
      {hasTail && (
        <div className="chat-tool-progress-tails">
          {progress.stdoutTail && (
            <pre className="md-view tool-detail tool-progress-tail">stdout: {progress.stdoutTail}</pre>
          )}
          {progress.stderrTail && (
            <pre className="md-view tool-detail tool-progress-tail">stderr: {progress.stderrTail}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCall({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const change = useMemo(() => diffFromTool(block), [block]);
  const evidenceSearch = useMemo(() => evidenceSearchSummaryFromTool(block), [block]);
  const webSearch = useMemo(() => webSearchSummaryFromTool(block), [block]);
  const oracleWeb = useMemo(() => oracleWebSummaryFromTool(block), [block]);
  const imagePaths = useMemo(() => imagePathsFromTool(block, change), [block, change]);
  const openChatFile = useOpenChatFile();
  const language = useStore((state) => state.language);
  const running = block.output === undefined;
  const evidenceCount = evidenceSearch?.items.length ?? 0;
  const status = oracleWeb
    ? language === "cn"
      ? running
        ? oracleWeb.kind === "image" ? "正在通过 ChatGPT 网页生成图片" : "正在咨询 ChatGPT 网页"
        : block.isError
          ? oracleWeb.kind === "image" ? "网页图片生成失败" : "网页咨询失败"
          : oracleWeb.kind === "image"
            ? `已生成 ${oracleWeb.imageCount} 张图片`
            : "ChatGPT 网页已回复"
      : running
        ? oracleWeb.kind === "image" ? "Generating through ChatGPT Web" : "Consulting ChatGPT Web"
        : block.isError
          ? oracleWeb.kind === "image" ? "Web image generation failed" : "Web consultation failed"
          : oracleWeb.kind === "image"
            ? `Generated ${oracleWeb.imageCount} image(s)`
            : "ChatGPT Web replied"
    : evidenceSearch
      ? language === "cn"
      ? running
        ? "正在检索"
        : block.isError
          ? "检索失败"
          : evidenceSearch.status === "empty" || evidenceCount === 0
            ? "未找到证据"
            : `已定位 ${evidenceCount} 条`
      : running
        ? "Searching"
        : block.isError
          ? "Search failed"
          : evidenceSearch.status === "empty" || evidenceCount === 0
            ? "No evidence"
            : `Found ${evidenceCount}`
      : webSearch
      ? language === "cn"
        ? running
          ? "正在检索"
          : block.isError || webSearch.status === "failed"
            ? "网页检索失败"
            : webSearch.coverage.exhausted
              ? `已完成 · ${webSearch.coverage.unique} 条`
              : `部分结果 · ${webSearch.coverage.unique} 条`
        : running
          ? "Searching"
          : block.isError || webSearch.status === "failed"
            ? "Web search failed"
            : webSearch.coverage.exhausted
              ? `Completed · ${webSearch.coverage.unique}`
              : `Partial · ${webSearch.coverage.unique}`
        : running ? "Running" : block.isError ? "Failed" : change ? "Modified file" : "Succeeded";
  const className = running
    ? "tool-running"
    : block.isError || webSearch?.status === "failed"
      ? "tool-error"
      : webSearch && !webSearch.coverage.exhausted
        ? "tool-warning"
        : change
          ? "tool-change"
          : "tool-done";
  const evidenceName = language === "cn" ? "本地文献证据" : "Local literature evidence";
  const toggle = () => {
    if (!running) setOpen((value) => !value);
  };
  return (
    <div className={`chat-tool ${className}`}>
      <div
        className="chat-tool-header"
        role="button"
        tabIndex={running ? -1 : 0}
        aria-disabled={running}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="tool-status-icon">{running ? <SvgIcon name="spinner" size={11} /> : block.isError ? <SvgIcon name="error" size={11} /> : change ? <SvgIcon name="modified" size={11} /> : <SvgIcon name="check" size={11} />}</span>
        <span className="tool-status-label">{status}</span>
        {change ? (
          <button
            type="button"
            className="tool-name tool-file-link"
            title={displayLocalFilePath(change.path)}
            onClick={(event) => {
              event.stopPropagation();
              openChatFile(change.path);
            }}
          >
            {displayLocalFilePath(change.path)}
          </button>
        ) : (
          <span className="tool-name">
            {oracleWeb
              ? oracleWeb.kind === "image"
                ? language === "cn" ? "ChatGPT 网页图片" : "ChatGPT Web image"
                : language === "cn" ? "ChatGPT 网页咨询" : "ChatGPT Web consultation"
              : evidenceSearch
              ? `${evidenceName}${evidenceSearch.query ? ` · ${evidenceSearch.query}` : ""}`
              : webSearch
                ? `${language === "cn" ? "网页检索" : "Web search"}${webSearch.query ? ` · ${webSearch.query}` : ""}`
              : block.name}
          </span>
        )}
        {!running && <span className="tool-collapse-btn"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={11} /></span>}
      </div>
      <ToolProgressView block={block} />
      {imagePaths.length > 0 && (
        <div className="chat-tool-images">
          {imagePaths.map((path) => (
            <ChatImagePreview
              key={path}
              src={path}
              alt={path}
              title={path}
              openPath={isDirectImageSource(path) ? undefined : path}
              className="chat-tool-image"
            />
          ))}
        </div>
      )}
      {open && (
        <div className="chat-tool-body">
          {oracleWeb ? (
            <div className="chat-oracle-web-result">
              <div className="chat-oracle-web-boundary">
                {language === "cn"
                  ? "第三方网页自动化 · 使用已绑定的隔离 ChatGPT 账号"
                  : "Third-party webpage automation · isolated assigned ChatGPT account"}
              </div>
              {oracleWeb.output && <p>{oracleWeb.output}</p>}
              {oracleWeb.sessionId && <code>Oracle session: {oracleWeb.sessionId}</code>}
            </div>
          ) : change ? (
            <pre className="tool-diff">{displayDiffPaths(change.diff)}</pre>
          ) : evidenceSearch ? (
            <div className="chat-evidence-search-details">
              {evidenceSearch.items.length === 0 ? (
                <p>{language === "cn" ? "当前本地索引中没有匹配证据。" : "No matching evidence was found in the local index."}</p>
              ) : (
                <ol>
                  {evidenceSearch.items.map((item, index) => (
                    <li key={`${item.citation ?? item.sourceType}-${index}`}>
                      <div>
                        <strong>
                          {item.sourceType === "confirmedKnowledge"
                            ? language === "cn" ? "已确认知识" : "Confirmed knowledge"
                            : language === "cn" ? "PDF 原文" : "Original PDF"}
                        </strong>
                        {item.citation && <code>{item.citation}</code>}
                      </div>
                      <p>{item.excerpt.length > 320 ? `${item.excerpt.slice(0, 320)}…` : item.excerpt}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : webSearch ? (
            <div className="chat-web-search-details">
              <div className="chat-web-search-coverage">
                <span>
                  <strong>{language === "cn" ? "覆盖" : "Coverage"}</strong>
                  {webSearch.coverage.exhausted
                    ? language === "cn" ? "已遍历" : "Exhausted"
                    : language === "cn" ? "未遍历完" : "Incomplete"}
                </span>
                <span>
                  <strong>{language === "cn" ? "获取" : "Fetched"}</strong>
                  {webSearch.coverage.fetched}
                </span>
                <span>
                  <strong>{language === "cn" ? "去重" : "Unique"}</strong>
                  {webSearch.coverage.unique}
                </span>
                {webSearch.coverage.totalHits !== undefined && (
                  <span>
                    <strong>{language === "cn" ? "总量" : "Total"}</strong>
                    {webSearch.coverage.totalHits}
                  </span>
                )}
                {webSearch.coverage.totalHits !== undefined
                  && webSearch.coverage.totalHits > 0 && (
                  <span>
                    <strong>{language === "cn" ? "覆盖率" : "Coverage rate"}</strong>
                    {Math.min(
                      100,
                      Math.round(
                        (webSearch.coverage.fetched / webSearch.coverage.totalHits) * 100,
                      ),
                    )}%
                  </span>
                )}
                {webSearch.maxResults !== undefined && (
                  <span>
                    <strong>maxResults</strong>
                    {webSearch.maxResults}
                  </span>
                )}
                {webSearch.cached && <span>{language === "cn" ? "缓存结果" : "Cached"}</span>}
              </div>
              {webSearch.retrievalControl && (
                <div className="chat-web-search-adaptive">
                  <strong>
                    {language === "cn" ? "LLM 自适应检索" : "LLM-adaptive retrieval"}
                  </strong>
                  <span>
                    {language === "cn"
                      ? `本批 ${webSearch.retrievalControl.batchLimit ?? webSearch.maxResults ?? "?"} 条；50 条仅是单批上下文保护，不是检索总上限。`
                      : `This batch is limited to ${webSearch.retrievalControl.batchLimit ?? webSearch.maxResults ?? "?"}; 50 is only a per-batch context guard, not a total search cap.`}
                  </span>
                  {webSearch.retrievalControl.availableUnsearchedProviders.length > 0 && (
                    <span>
                      {language === "cn" ? "尚未检索：" : "Not searched yet: "}
                      {webSearch.retrievalControl.availableUnsearchedProviders.join(", ")}
                    </span>
                  )}
                  {webSearch.retrievalControl.recommendedAction && (
                    <small>{webSearch.retrievalControl.recommendedAction}</small>
                  )}
                </div>
              )}
              {!webSearch.coverage.exhausted && (
                <p className="chat-web-search-warning">
                  {language === "cn"
                    ? `覆盖尚未完成${webSearch.coverage.truncatedReason ? `：${webSearch.coverage.truncatedReason}` : ""}。不能据此声称“没有更多结果”。`
                    : `Coverage is incomplete${webSearch.coverage.truncatedReason ? `: ${webSearch.coverage.truncatedReason}` : ""}. Do not treat this as an exhaustive result set.`}
                </p>
              )}
              {webSearch.attempts.length > 0 && (
                <div className="chat-web-search-attempts">
                  {webSearch.attempts.map((attempt, index) => (
                    <div key={`${attempt.provider}-${index}`} className={`web-attempt web-attempt-${attempt.status}`}>
                      <strong>{attempt.provider}</strong>
                      <span>{attempt.status}</span>
                      <span>{attempt.fetched} / {attempt.unique}</span>
                      {!attempt.exhausted && attempt.truncatedReason && <code>{attempt.truncatedReason}</code>}
                      {attempt.error && <small>{attempt.error}</small>}
                    </div>
                  ))}
                </div>
              )}
              {webSearch.variants.length > 0 && (
                <details>
                  <summary>
                    {language === "cn"
                      ? `查询变体（${webSearch.variants.length}）`
                      : `Query variants (${webSearch.variants.length})`}
                  </summary>
                  <ul className="chat-web-search-variants">
                    {webSearch.variants.map((variant, index) => (
                      <li key={`${variant.kind}-${index}`}>
                        <code>{variant.kind}</code>
                        <span>{variant.query}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {webSearch.hits.length === 0 ? (
                <p>{language === "cn" ? "当前页没有可用结果。" : "No usable results on this page."}</p>
              ) : (
                <ol className="chat-web-search-results">
                  {webSearch.hits.map((hit, index) => (
                    <li key={`${hit.url}-${index}`}>
                      <div>
                        <a href={hit.url} target="_blank" rel="noreferrer">{hit.title}</a>
                        <span>
                          {hit.provider ?? webSearch.provider}
                          {hit.sourceKind === "community"
                            ? language === "cn" ? " · 社区观点" : " · community view"
                            : ""}
                          {hit.authorName ? ` · ${hit.authorName}` : ""}
                          {hit.rank !== undefined ? ` · #${hit.rank}` : ""}
                        </span>
                      </div>
                      {hit.snippet && <p>{hit.snippet}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : (
            <>
              {block.input && block.input !== "{}" && <pre className="md-view tool-detail">{block.input}</pre>}
              {block.output !== undefined && <pre className="md-view tool-detail tool-output">{block.output}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type ChangeRevertPhase = "idle" | "reverting" | "reverted" | "conflict" | "error";

interface ChangeRevertState {
  phase: ChangeRevertPhase;
  message?: string;
}

function reviewDiffForFile(file: TurnFileSummary): string {
  if (file.changes.length === 1) return displayDiffPaths(file.changes[0].diff);
  return file.changes
    .map((change, index) => {
      const toolId = change.toolUseId ? ` ${change.toolUseId}` : "";
      return [`# ${index + 1}. ${change.sourceTool}${toolId}`, displayDiffPaths(change.diff)].join("\n");
    })
    .join("\n\n");
}

function displayDiffPaths(diff: string): string {
  return diff.replace(/^(---|\+\+\+) ([^\r\n]+)$/gm, (_line, marker: string, path: string) => (
    `${marker} ${displayLocalFilePath(path)}`
  ));
}

export function EditedFilesSummary({ summary }: { summary: TurnFileChangeSummary }) {
  const language = useStore((state) => state.language);
  const openChatFile = useOpenChatFile();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedPath, setSelectedPath] = useState(summary.files[0]?.path ?? "");
  const [revertState, setRevertState] = useState<ChangeRevertState>({ phase: "idle" });
  const visibleLimit = 3;
  const visibleFiles = showAll ? summary.files : summary.files.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, summary.files.length - visibleFiles.length);
  const selectedFile = summary.files.find((file) => file.path === selectedPath) ?? summary.files[0];
  const hasRevertIds = summary.changeIds.length > 0;
  const isChinese = language === "cn";
  const title = isChinese
    ? `已编辑 ${summary.fileCount} 个文件`
    : `Edited ${summary.fileCount} ${summary.fileCount === 1 ? "file" : "files"}`;
  const undoLabel = isChinese
    ? revertState.phase === "reverting" ? "撤销中" : revertState.phase === "reverted" ? "已撤销" : "撤销"
    : revertState.phase === "reverting" ? "Undoing" : revertState.phase === "reverted" ? "Reverted" : "Undo";
  const reviewLabel = isChinese ? "审核" : "Review";

  const revertChanges = async () => {
    if (!hasRevertIds || revertState.phase === "reverting" || revertState.phase === "reverted") return;
    setRevertState({ phase: "reverting" });
    let revertedCount = 0;
    const withPartialProgress = (message: string) => {
      if (revertedCount === 0) return message;
      return isChinese
        ? `已撤销 ${revertedCount} 项更改；${message}`
        : `Reverted ${revertedCount} change${revertedCount === 1 ? "" : "s"}; ${message}`;
    };
    try {
      for (const changeId of [...summary.changeIds].reverse()) {
        const result = await chatChangeRevert(changeId);
        if (result.conflict) {
          setRevertState({ phase: "conflict", message: withPartialProgress(result.conflict) });
          return;
        }
        if (!result.reverted) {
          setRevertState({
            phase: "error",
            message: withPartialProgress(result.reason ?? (isChinese ? "该改动无法撤销" : "This change could not be reverted")),
          });
          return;
        }
        revertedCount += 1;
      }
      setRevertState({ phase: "reverted", message: isChinese ? "已回撤本轮文件改动" : "Reverted this turn's file edits" });
    } catch (error) {
      setRevertState({
        phase: "error",
        message: withPartialProgress(error instanceof Error ? error.message : String(error)),
      });
    }
  };

  return (
    <section className="chat-change-summary" aria-label={title}>
      <div className="chat-change-summary-head">
        <span className="chat-change-summary-icon" aria-hidden="true">
          <SvgIcon name="modified" size={18} />
        </span>
        <div className="chat-change-summary-title">
          <strong>{title}</strong>
          <span>
            <span className="chat-change-added">{formatCount(summary.addedLines, "+")}</span>
            <span className="chat-change-removed">{formatCount(summary.removedLines, "-")}</span>
          </span>
        </div>
        <div className="chat-change-summary-actions">
          <button
            type="button"
            disabled={!hasRevertIds || revertState.phase === "reverting" || revertState.phase === "reverted"}
            title={hasRevertIds ? undefined : (isChinese ? "此记录缺少 changeId" : "This record has no changeId")}
            onClick={() => void revertChanges()}
          >
            {undoLabel}
          </button>
          <button
            type="button"
            aria-expanded={reviewOpen}
            onClick={() => setReviewOpen((value) => !value)}
          >
            {reviewLabel}
          </button>
        </div>
      </div>
      <div className="chat-change-file-list">
        {visibleFiles.map((file) => (
          <div key={file.path} className="chat-change-file-row">
            <button
              type="button"
              className="chat-change-file-path"
              title={displayLocalFilePath(file.path)}
              onClick={() => openChatFile(file.path)}
            >
              {displayLocalFilePath(file.path)}
            </button>
            <span className="chat-change-file-stats">
              <span className="chat-change-added">{formatCount(file.addedLines, "+")}</span>
              <span className="chat-change-removed">{formatCount(file.removedLines, "-")}</span>
            </span>
          </div>
        ))}
      </div>
      {summary.files.length > visibleLimit && (
        <button type="button" className="chat-change-more" onClick={() => setShowAll((value) => !value)}>
          {showAll
            ? (isChinese ? "收起文件" : "Show fewer files")
            : (isChinese ? `再显示 ${hiddenCount} 个文件` : `Show ${hiddenCount} more files`)}
        </button>
      )}
      {revertState.message && (
        <div className={`chat-change-revert-note ${revertState.phase}`}>
          {revertState.message}
        </div>
      )}
      {reviewOpen && selectedFile && (
        <div className="chat-change-review">
          {summary.files.length > 1 && (
            <div className="chat-change-review-tabs" role="tablist" aria-label={isChinese ? "文件 diff" : "File diffs"}>
              {summary.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  role="tab"
                  aria-selected={file.path === selectedFile.path}
                  title={displayLocalFilePath(file.path)}
                  onClick={() => setSelectedPath(file.path)}
                >
                  {displayLocalFilePath(file.path)}
                </button>
              ))}
            </div>
          )}
          <pre className="tool-diff chat-change-review-diff">{reviewDiffForFile(selectedFile)}</pre>
        </div>
      )}
    </section>
  );
}

/**
 * Collapses a run of consecutive calls to the same tool (e.g. 77 × mail_move)
 * into one card with a `current/total` progress counter. Expanding it reveals
 * the individual calls, each still independently expandable.
 */
function ToolGroup({ blocks }: { blocks: Extract<ChatBlock, { kind: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  const total = blocks.length;
  const done = blocks.filter((b) => b.output !== undefined).length;
  const running = done < total;
  const anyError = blocks.some((b) => b.isError);
  const status = running ? "Running" : anyError ? "Failed" : "Succeeded";
  const className = running ? "tool-running" : anyError ? "tool-error" : "tool-done";
  // While running, point at the call in flight (done + 1); when finished, total.
  const current = running ? Math.min(done + 1, total) : total;
  const toggle = () => setOpen((value) => !value);
  return (
    <div className={`chat-tool chat-tool-group ${className}`}>
      <div
        className="chat-tool-header"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="tool-status-icon">{running ? <SvgIcon name="spinner" size={11} /> : anyError ? <SvgIcon name="error" size={11} /> : <SvgIcon name="check" size={11} />}</span>
        <span className="tool-status-label">{status}</span>
        <span className="tool-name">{blocks[0].name}</span>
        <span className="tool-group-count" title={`${current} / ${total}`}>
          {current}/{total}
        </span>
        <span className="tool-collapse-btn"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={11} /></span>
      </div>
      {open && (
        <div className="chat-tool-body chat-tool-group-body">
          {blocks.map((b, i) => (
            <ToolCall key={b.id ?? i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionCall({
  block,
  onPermissionRespond,
}: {
  block: Extract<ChatBlock, { kind: "permission" }>;
  onPermissionRespond: (promptId: string, allow: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = !block.status || block.status === "pending";
  const status = block.status === "allowed" ? "Continued" : block.status === "skipped" ? "Skipped" : "Waiting";
  return (
    <div className={`chat-tool chat-permission-card ${pending ? "tool-running" : block.status === "skipped" ? "tool-error" : "tool-done"}`}>
      <div className="chat-tool-header">
        <span className="tool-status-icon">{pending ? <SvgIcon name="pending" size={11} /> : block.status === "skipped" ? <SvgIcon name="warning" size={11} /> : <SvgIcon name="check" size={11} />}</span>
        <span className="tool-status-label">{status}</span>
        <span className="tool-name">{block.toolName}</span>
        <span className="tool-status-label">{block.currentMode} to {block.requiredMode}</span>
      </div>
      <div className="chat-permission-actions">
        <button type="button" disabled={!pending} onClick={() => onPermissionRespond(block.id, true)}>
          Continue
        </button>
        <button type="button" disabled={!pending} onClick={() => onPermissionRespond(block.id, false)}>
          Skip
        </button>
        {block.input && (
          <button type="button" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide input" : "Show input"}
          </button>
        )}
      </div>
      {open && block.input && (
        <div className="chat-tool-body">
          <pre className="md-view tool-detail">{block.input}</pre>
        </div>
      )}
    </div>
  );
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

/** Parses an `AskUserQuestion` tool input into a renderable question, or null
 *  if it isn't a well-formed question (the caller falls back to a tool card). */
function parseQuestionSpec(input: string): QuestionSpec | null {
  try {
    const value = JSON.parse(input) as Partial<QuestionSpec>;
    if (!value || typeof value.question !== "string" || !Array.isArray(value.options)) return null;
    const options = value.options.filter(
      (option): option is QuestionOption =>
        Boolean(option) && typeof (option as QuestionOption).label === "string",
    );
    if (options.length === 0) return null;
    return {
      question: value.question,
      header: typeof value.header === "string" && value.header.trim() ? value.header : undefined,
      options,
      multiSelect: value.multiSelect === true,
      // Free-form answers are allowed unless the model explicitly opts out.
      allowCustom: value.allowCustom !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Renders an `AskUserQuestion` tool call as an interactive prompt: option
 * buttons (and, by default, a free-text answer) while the backend tool is
 * blocked waiting; once `output` arrives the user's answer is shown read-only.
 */
function QuestionCall({
  block,
  active,
  queued,
  onQuestionRespond,
}: {
  block: Extract<ChatBlock, { kind: "tool" }>;
  active: boolean;
  /** An earlier AskUserQuestion call in the same turn hasn't been answered yet. */
  queued: boolean;
  onQuestionRespond: (toolUseId: string, answer: string) => Promise<void>;
}) {
  const spec = useMemo(() => parseQuestionSpec(block.input), [block.input]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const submittingRef = useRef(false);

  // Not a usable question — show the raw tool call rather than an empty card.
  if (!spec) return <ToolCall block={block} />;

  const resolved = block.output !== undefined;
  const waitingForBackend = !resolved && block.ready !== true;
  // Interactive only while the turn is still running and waiting on this call;
  // a stopped/finished turn leaves the question unanswerable.
  const interactive = !resolved && active && !waitingForBackend;
  const locked = !interactive || submitting || submittingRef.current || !block.id;
  const send = async (answer: string) => {
    const text = answer.trim();
    if (locked || submittingRef.current || !block.id || !text) return;
    // A state update is not visible until the next render. Latch first so two
    // clicks in the same tick cannot answer this tool call twice.
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onQuestionRespond(block.id, text);
    } catch {
      // The backend can reject a stale/dismissed prompt. Never leave the card
      // permanently latched in "Sending…"; the ready handshake will keep a
      // not-yet-registered serial question locked until it can accept answers.
      submittingRef.current = false;
      setSubmitting(false);
      setSubmitError("The answer could not be submitted. Please try again.");
    }
  };
  const sendSelection = () => {
    const labels = [...selected].sort((a, b) => a - b).map((i) => spec.options[i].label);
    if (spec.allowCustom && custom.trim()) labels.push(custom.trim());
    void send(labels.join(", "));
  };
  const toggle = (index: number) => {
    if (locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const canSubmit = spec.multiSelect ? selected.size > 0 || custom.trim().length > 0 : custom.trim().length > 0;
  const answered = resolved && !block.isError;
  // Queued (an earlier question in the same turn is still unanswered) is a
  // normal waiting state, not a problem — it gets the same pending look as
  // "awaiting answer" rather than the warning styling used for a genuinely
  // stale/unanswerable question.
  const pending = !resolved && (interactive || queued || waitingForBackend);
  const statusClass = answered ? "tool-done" : pending ? "tool-running" : "tool-error";
  const statusIcon = answered ? <SvgIcon name="check" size={11} /> : pending ? <SvgIcon name="pending" size={11} /> : <SvgIcon name="warning" size={11} />;
  const statusLabel = answered
    ? "Answered"
    : interactive
      ? "Awaiting your answer"
      : waitingForBackend
        ? "Preparing"
        : queued
          ? "Queued"
          : "Unanswered";

  return (
    <div className={`chat-tool chat-question-card ${statusClass}`}>
      <div className="chat-tool-header">
        <span className="tool-status-icon">{statusIcon}</span>
        <span className="tool-status-label">{statusLabel}</span>
        {spec.header && <span className="tool-name">{spec.header}</span>}
      </div>
      <div className="chat-question-body">
        <p className="chat-question-text">{spec.question}</p>
        {resolved ? (
          <div className="chat-question-answer">
            <span className="chat-question-answer-label">{block.isError ? "Not answered" : "You answered"}</span>
            <span className="chat-question-answer-value">{block.output}</span>
          </div>
        ) : !interactive ? (
          <p className="chat-question-stale">
            {waitingForBackend
              ? "Preparing this question…"
              : queued
              ? "Answer the question above first — this one will follow."
              : "This question is no longer awaiting an answer."}
          </p>
        ) : (
          <>
            <div className={`chat-question-options${spec.multiSelect ? " is-multi" : ""}`}>
              {spec.options.map((option, index) => (
                <button
                  key={index}
                  type="button"
                  className={`chat-question-option${selected.has(index) ? " selected" : ""}`}
                  disabled={locked}
                  onClick={() => {
                    if (spec.multiSelect) toggle(index);
                    else void send(option.label);
                  }}
                >
                  <span className="chat-question-option-label">{option.label}</span>
                  {option.description && (
                    <span className="chat-question-option-desc">{option.description}</span>
                  )}
                </button>
              ))}
            </div>
            {spec.allowCustom && (
              <input
                className="chat-question-custom"
                type="text"
                placeholder="Or type your own answer…"
                value={custom}
                disabled={locked}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (spec.multiSelect) sendSelection();
                    else void send(custom);
                  }
                }}
              />
            )}
            {(spec.multiSelect || spec.allowCustom) && (
              <div className="chat-question-actions">
                <button
                  type="button"
                  disabled={locked || !canSubmit}
                  onClick={spec.multiSelect ? sendSelection : () => void send(custom)}
                >
                  {submitting ? "Sending…" : "Submit"}
                </button>
              </div>
            )}
            {submitError && <p className="chat-question-stale">{submitError}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function renderSingleBlock(
  block: ChatBlock,
  index: number,
  turn: ChatTurn,
  evidenceSources: MarkdownEvidenceSource[],
  firstPendingQuestionIndex: number,
  onPermissionRespond: (promptId: string, allow: boolean) => void,
  onQuestionRespond: (toolUseId: string, answer: string) => Promise<void>,
  onOpenIndependentReview: () => void,
) {
  if (block.kind === "text") {
    if (!block.text) return null;
    return turn.role === "assistant" ? (
      <MarkdownContent
        key={index}
        text={block.text}
        evidenceSources={evidenceSources}
        streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)}
      />
    ) : (
      <div key={index} className="chat-text">
        {block.text}
      </div>
    );
  }
  if (block.kind === "thinking") {
    return block.thinking ? (
      <ThinkBlock
        key={index}
        content={block.thinking}
        streaming={Boolean(turn.streaming && index === turn.blocks.length - 1)}
      />
    ) : null;
  }
  if (block.kind === "notice") {
    return block.message ? (
      <div key={index} className="chat-context-notice">
        <SvgIcon name="pending" size={14} className="chat-context-notice-icon" />
        <span className="chat-context-notice-message">{block.message}</span>
      </div>
    ) : null;
  }
  if (block.kind === "review") {
    return <IndependentReviewBadge key={index} block={block} onOpen={onOpenIndependentReview} />;
  }
  if (block.kind === "permission") {
    return <PermissionCall key={block.id} block={block} onPermissionRespond={onPermissionRespond} />;
  }
  // TodoWrite plans are surfaced by the floating workflow box, not inline.
  if (block.kind === "tool" && block.name === "TodoWrite") return null;
  if (block.kind === "tool" && block.name === "AskUserQuestion") {
    return (
      <QuestionCall
        key={block.id ?? index}
        block={block}
        active={Boolean(turn.streaming) && block.ready === true && index === firstPendingQuestionIndex}
        queued={block.output === undefined && index !== firstPendingQuestionIndex}
        onQuestionRespond={onQuestionRespond}
      />
    );
  }
  return <ToolCall key={block.id ?? index} block={block} />;
}

function renderAssistantTextRun(
  blocks: ChatBlock[],
  start: number,
  end: number,
  turn: ChatTurn,
  latestThinkingIndex: number,
  evidenceSources: MarkdownEvidenceSource[],
) {
  const text = blocks
    .filter((block): block is Extract<ChatBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
  const thinking = blocks
    .filter((block): block is Extract<ChatBlock, { kind: "thinking" }> => block.kind === "thinking")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
  const last = blocks[blocks.length - 1];
  const isTailRun = end === turn.blocks.length;
  return (
    <Fragment key={`assistant-text-run-${start}`}>
      {thinking && (
        <ThinkBlock
          content={thinking}
          streaming={Boolean(turn.streaming && isTailRun && last?.kind === "thinking")}
          revealWhileTurnStreaming={Boolean(
            turn.streaming && latestThinkingIndex >= start && latestThinkingIndex < end
          )}
        />
      )}
      {text.trim() && (
        <MarkdownContent
          text={text}
          evidenceSources={evidenceSources}
          streaming={Boolean(turn.streaming && isTailRun && last?.kind === "text")}
        />
      )}
    </Fragment>
  );
}

/**
 * Renders a turn's blocks, collapsing runs of ≥2 consecutive calls to the same
 * tool into a single {@link ToolGroup}. Other blocks render individually.
 */
function renderBlocks(
  turn: ChatTurn,
  onPermissionRespond: (promptId: string, allow: boolean) => void,
  onQuestionRespond: (toolUseId: string, answer: string) => Promise<void>,
  onOpenIndependentReview: () => void,
) {
  const blocks = turn.blocks;
  const evidenceSources = blocks
    .filter((block): block is ChatToolBlock => block.kind === "tool")
    .flatMap(evidenceSourcesFromTool);
  const out: ReactNode[] = [];
  let latestThinkingIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "thinking") {
      latestThinkingIndex = index;
      break;
    }
  }
  // Multiple AskUserQuestion calls can land in one turn when the model asks
  // several clarifying questions at once; the backend still resolves them one
  // at a time, so only the earliest unanswered one is interactive — the rest
  // wait their turn instead of all popping up together.
  const firstPendingQuestionIndex = blocks.findIndex(
    (block) => block.kind === "tool" && block.name === "AskUserQuestion" && block.output === undefined,
  );
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (turn.role === "assistant" && (block.kind === "text" || block.kind === "thinking")) {
      let j = i + 1;
      while (j < blocks.length && (blocks[j].kind === "text" || blocks[j].kind === "thinking")) {
        j += 1;
      }
      out.push(renderAssistantTextRun(
        blocks.slice(i, j),
        i,
        j,
        turn,
        latestThinkingIndex,
        evidenceSources,
      ));
      i = j;
      continue;
    }
    // AskUserQuestion is interactive and rendered individually, never collapsed.
    if (
      block.kind === "tool"
      && block.name !== "TodoWrite"
      && block.name !== "AskUserQuestion"
      && block.name !== "ProjectEvidenceSearch"
      && block.name !== "WebSearch"
    ) {
      let j = i + 1;
      while (j < blocks.length) {
        const next = blocks[j];
        if (next.kind !== "tool" || next.name !== block.name) break;
        j += 1;
      }
      if (j - i > 1) {
        const run = blocks.slice(i, j) as Extract<ChatBlock, { kind: "tool" }>[];
        out.push(<ToolGroup key={block.id ?? `group-${i}`} blocks={run} />);
        i = j;
        continue;
      }
    }
    out.push(renderSingleBlock(
      block,
      i,
      turn,
      evidenceSources,
      firstPendingQuestionIndex,
      onPermissionRespond,
      onQuestionRespond,
      onOpenIndependentReview,
    ));
    i += 1;
  }
  return out;
}

function hasRenderableContent(turn: ChatTurn): boolean {
  return turn.blocks.some((block) => {
    if (block.kind === "text") return Boolean(block.text.trim());
    if (block.kind === "thinking") return Boolean(block.thinking.trim());
    return true;
  });
}

function renderAttachment(attachment: NonNullable<ChatTurn["attachments"]>[number], imageLabel: string, fileLabel: string) {
  if (attachment.kind === "image" && (attachment.preview || attachment.path)) {
    const src = attachment.preview ?? attachment.path!;
    return (
      <ChatImagePreview
        key={attachment.id}
        src={src}
        alt={attachment.name}
        title={attachment.name}
        openPath={attachment.path}
        className="chat-user-image"
      />
    );
  }
  return (
    <span key={attachment.id} className="chat-message-attachment-badge">
      {attachment.kind === "image" ? imageLabel : fileLabel}: {attachment.name}
    </span>
  );
}

interface Props {
  turn: ChatTurn;
  canRetry: boolean;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
  onPermissionRespond?: (promptId: string, allow: boolean) => void;
  onQuestionRespond?: (toolUseId: string, answer: string) => Promise<void>;
  onOpenIndependentReview?: () => void;
}

function ChatMessage({
  turn,
  canRetry,
  onEdit,
  onRetry,
  onContinue,
  onPermissionRespond = () => undefined,
  onQuestionRespond = async () => undefined,
  onOpenIndependentReview = () => undefined,
}: Props) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const text = textFromTurn(turn);
  const hasContent = hasRenderableContent(turn);
  const blockNodes = renderBlocks(
    turn,
    onPermissionRespond,
    onQuestionRespond,
    onOpenIndependentReview,
  );
  return (
    <article className={`chat-turn chat-${turn.role}${turn.error ? " chat-turn-error" : ""}`}>
      {turn.role === "user" && turn.attachments && turn.attachments.length > 0 && (
        <div className="chat-message-attachments">
          {turn.attachments.map((attachment) => renderAttachment(attachment, copy.image, copy.file))}
        </div>
      )}
      {blockNodes}
      {!turn.streaming && !turn.error && !turn.stopped && !hasContent && turn.role === "assistant" && (
        <div className="chat-empty-response">{copy.emptyResponse}</div>
      )}
      {!turn.streaming && !turn.error && turn.stopped && turn.role === "assistant" && (
        <div className="chat-stopped-card">
          <strong>{copy.responseStopped}</strong>
          <span>{copy.stoppedByUser}</span>
        </div>
      )}
      {turn.streaming && <span className="chat-inline-cursor" aria-hidden="true" />}
      {turn.error && (
        <div className="chat-error-card">
          <strong>{copy.responseFailed}</strong>
          <span>{turn.error}</span>
          <button onClick={() => onRetry(turn)}>{copy.retry}</button>
        </div>
      )}
      <div className="chat-message-actions">
        {text && <CopyButton text={text} />}
        {turn.role === "user" && !turn.readOnly && !turn.streaming && <button onClick={() => onEdit(turn)}>{copy.editAndResend}</button>}
        {turn.role === "assistant" && canRetry && !turn.streaming && !turn.error && <button onClick={() => onRetry(turn)}>{copy.retry}</button>}
        {turn.role === "assistant" && turn.stopped && <button onClick={onContinue}>{copy.continue}</button>}
      </div>
    </article>
  );
}

export default memo(ChatMessage);
