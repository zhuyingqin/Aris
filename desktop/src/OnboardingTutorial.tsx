import { useEffect, useMemo, useState, type CSSProperties } from "react";

export const ONBOARDING_STORAGE_KEY = "somniq-onboarding-v2";

const PRIOR_USAGE_STORAGE_KEYS = [
  "somniq-sidebar-w",
  "somniq-sidebar-collapsed",
  "somniq-chat-sessions-v2",
  "somniq-chat-current-id",
  "somniq-chat-sidebar-w",
  "somniq-chat-recent-files",
  "somniq-chat-recent-skills",
  "somniq-lab-side-w",
  "somniq-lab-assistant-w",
  "somniq-lab-assistant-sessions-v1",
  "somniq-mail-list-width",
  "somniq-mail-assistant-width",
  "somniq-providers-v1",
  "aris-onboarding-v2",
  "aris-sidebar-w",
  "aris-sidebar-collapsed",
  "aris-chat-sessions-v2",
  "aris-chat-sessions",
  "aris-chat-current-id",
  "aris-chat-sidebar-w",
  "aris-chat-recent-files",
  "aris-chat-recent-skills",
  "aris-lab-side-w",
  "aris-lab-assistant-w",
  "aris-lab-assistant-sessions-v1",
  "aris-mail-list-width",
  "aris-mail-assistant-width",
  "aris-providers-v1",
];

type OnboardingPlacement = "right" | "left" | "top" | "bottom" | "inside";

interface TargetRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface OnboardingStep {
  kicker: string;
  title: string;
  body: string;
  points: string[];
  targetSelectors: string[];
  placement: OnboardingPlacement;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    kicker: "功能入口",
    title: "左上角菜单：在各个模块间切换",
    body: "点击 SomniQ Chat 就能打开功能菜单，切换到其它工作模块。当前所在模块会高亮显示。",
    points: [
      "对话：提出任务，让代理读代码、改文件、跑命令",
      "代码 / LaTeX：编写程序、运行实验和排版论文",
      "文献 / 工作室：检索论文、整理资料，查看生成的 slides 和海报",
      "邮箱 / 扩展：收发邮件，管理已连接的工具和技能",
    ],
    targetSelectors: ['[data-onboarding-target="product-switcher"]'],
    placement: "bottom",
  },
  {
    kicker: "主工作区",
    title: "Chat 区：当前正在做事的地方",
    body: "中间这块会显示对话、工具调用、执行结果和错误提示。你主要在这里输入需求、看过程、确认结果。",
    points: [
      "左侧栏按「置顶」「项目」分组显示历史对话，点文件夹图标可展开或折叠",
      "把目标、报错或文件路径直接发给 Chat",
      "代理执行命令时，过程、结果和修改摘要都会显示在这里",
    ],
    targetSelectors: ['[data-onboarding-target="workspace"]'],
    placement: "inside",
  },
  {
    kicker: "当前项目",
    title: "项目切换器：告诉代理在哪个目录工作",
    body: "顶部这里决定当前工作目录。切错项目时，代理会读错文件，所以开始任务前先确认这里。",
    points: [
      "点击项目名切换已有项目",
      "点 Add 添加新的项目目录",
      "右侧路径用来确认当前目录是否正确",
    ],
    targetSelectors: ['[data-onboarding-target="project-switcher"]'],
    placement: "bottom",
  },
  {
    kicker: "设置入口",
    title: "Settings：先把模型和权限配好",
    body: "如果 Chat 不能正常回复，通常先来这里配置模型供应商、API Key、执行权限和连接能力。",
    points: [
      "模型和 API Key 在 Settings 里配置",
      "权限控制会影响代理能否执行命令和改文件",
      "配置完成后再回到 Chat 开始任务",
    ],
    targetSelectors: ['[data-onboarding-target="user-settings"]', '[data-onboarding-target="user-menu"]'],
    placement: "bottom",
  },
];

function readSeenFlag() {
  if (typeof window === "undefined") return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("typesetPreview") === "1" || params.get("labPreview") === "1") {
      writeSeenFlag();
      return true;
    }
    if (window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "done") return true;
    if (PRIOR_USAGE_STORAGE_KEYS.some((key) => window.localStorage.getItem(key) != null)) {
      writeSeenFlag();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function writeSeenFlag() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
    window.localStorage.removeItem("aris-onboarding-v2");
  } catch {
    // The tutorial can still close for the current session if storage is unavailable.
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isVisibleRect(rect: DOMRect) {
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  return (
    rect.width >= 12 &&
    rect.height >= 12 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewportWidth &&
    rect.top < viewportHeight
  );
}

function targetRectFromElement(element: Element): TargetRect | null {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  if (!isVisibleRect(rect)) return null;
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function findTargetRect(selectors: string[]): TargetRect | null {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const rect = targetRectFromElement(element);
    if (rect) return rect;
  }
  return null;
}

function spotlightStyle(rect: TargetRect): CSSProperties {
  const pad = 7;
  return {
    top: `${Math.max(4, rect.top - pad)}px`,
    left: `${Math.max(4, rect.left - pad)}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  };
}

function cardStyle(rect: TargetRect | null, placement: OnboardingPlacement): CSSProperties | undefined {
  if (!rect) return undefined;

  const margin = 16;
  const gap = 16;
  const cardWidth = Math.min(390, Math.max(280, window.innerWidth - margin * 2));
  const estimatedCardHeight = 326;
  let left = rect.right + gap;
  let top = rect.top + rect.height / 2 - estimatedCardHeight / 2;

  if (placement === "left") {
    left = rect.left - gap - cardWidth;
  } else if (placement === "top") {
    left = rect.left + rect.width / 2 - cardWidth / 2;
    top = rect.top - gap - estimatedCardHeight;
  } else if (placement === "bottom") {
    left = rect.left + rect.width / 2 - cardWidth / 2;
    top = rect.bottom + gap;
  } else if (placement === "inside") {
    left = rect.left + 24;
    top = rect.top + 24;
  }

  if (placement === "right" && left + cardWidth + margin > window.innerWidth) {
    left = rect.left - gap - cardWidth;
  }
  if (placement === "left" && left < margin) {
    left = rect.right + gap;
  }
  if (placement === "bottom" && top + estimatedCardHeight + margin > window.innerHeight) {
    top = rect.top - gap - estimatedCardHeight;
  }
  if (placement === "top" && top < margin) {
    top = rect.bottom + gap;
  }

  return {
    left: `${clamp(left, margin, window.innerWidth - cardWidth - margin)}px`,
    top: `${clamp(top, margin, window.innerHeight - estimatedCardHeight - margin)}px`,
    width: `${cardWidth}px`,
  };
}

export default function OnboardingTutorial() {
  const [open, setOpen] = useState(() => !readSeenFlag());
  const [index, setIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const step = ONBOARDING_STEPS[index];
  const isFirstStep = index === 0;
  const isLastStep = index === ONBOARDING_STEPS.length - 1;
  const progressLabel = useMemo(
    () => `${index + 1} / ${ONBOARDING_STEPS.length}`,
    [index],
  );
  const cardPosition = useMemo(
    () => cardStyle(targetRect, step.placement),
    [step.placement, targetRect],
  );

  const close = () => {
    writeSeenFlag();
    setOpen(false);
  };

  const next = () => {
    if (isLastStep) {
      close();
      return;
    }
    setIndex((current) => Math.min(current + 1, ONBOARDING_STEPS.length - 1));
  };

  const previous = () => {
    setIndex((current) => Math.max(current - 1, 0));
  };

  useEffect(() => {
    if (!open) return;

    const updateTarget = () => {
      setTargetRect(findTargetRect(step.targetSelectors));
    };
    updateTarget();
    const timeout = window.setTimeout(updateTarget, 80);
    window.addEventListener("resize", updateTarget);
    window.addEventListener("scroll", updateTarget, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", updateTarget);
      window.removeEventListener("scroll", updateTarget, true);
    };
  }, [index, open, step.targetSelectors]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isLastStep, open]);

  if (!open) return null;

  return (
    <div className={`onboarding-backdrop${targetRect ? "" : " no-target"}`} role="presentation">
      {targetRect && (
        <div
          className="onboarding-spotlight"
          style={spotlightStyle(targetRect)}
          aria-hidden="true"
        />
      )}
      <section
        className={`onboarding-card${targetRect ? " anchored" : ""}`}
        style={cardPosition}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-body"
      >
        <div className="onboarding-progress" aria-label={`教程进度：${progressLabel}`}>
          {ONBOARDING_STEPS.map((item, itemIndex) => (
            <span
              key={item.title}
              className={`onboarding-progress-dot${itemIndex <= index ? " active" : ""}`}
            />
          ))}
        </div>

        <div className="onboarding-kicker">
          {step.kicker}
          <span>{progressLabel}</span>
        </div>
        <h2 id="onboarding-title">{step.title}</h2>
        <p id="onboarding-body">{step.body}</p>

        <ul className="onboarding-points">
          {step.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>

        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-back"
            onClick={previous}
            disabled={isFirstStep}
          >
            上一步
          </button>
          <button type="button" className="onboarding-skip" onClick={close}>
            跳过
          </button>
          <button type="button" className="primary" onClick={next}>
            {isLastStep ? "开始使用" : "下一步"}
          </button>
        </div>
      </section>
    </div>
  );
}
