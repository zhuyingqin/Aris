import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useStore, type Language } from "./store";

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

const CN_STEPS: OnboardingStep[] = [
  {
    kicker: "功能入口",
    title: "左侧图标栏：在研究工作区间切换",
    body: "点击左侧图标切换到对话、代码、LaTeX 或文献库，当前模块会保持高亮。其他功能位于更多菜单中。",
    points: [
      "Chat：提出任务，查看代理执行过程和结果",
      "文献：检索、整理和引用研究资料",
      "代码 / LaTeX：编写程序、运行实验和排版论文",
      "更多：打开研究流程、邮箱和设置",
    ],
    targetSelectors: ['[data-onboarding-target="module-navigation"]'],
    placement: "right",
  },
  {
    kicker: "主工作区",
    title: "Chat：把研究任务交给代理",
    body: "中间区域会显示对话、工具调用、执行结果和错误提示。把目标、材料或报错直接发给 Chat。",
    points: [
      "左侧栏按「置顶」「项目」整理历史对话",
      "代理执行命令时，过程和修改摘要会显示在这里",
      "需要继续工作时，回到对应项目和会话即可",
    ],
    targetSelectors: ['[data-onboarding-target="workspace"]'],
    placement: "inside",
  },
  {
    kicker: "当前项目",
    title: "项目切换器：告诉代理在哪个目录工作",
    body: "顶部这里决定当前工作目录。切错项目时，代理会读错文件，所以开始任务前先确认这里。",
    points: [
      "点击顶部项目名，展开已有项目列表",
      "在面板底部选择“添加本地项目…”来添加目录",
      "查看项目下方的路径，或选择“打开项目文件夹”确认目录",
    ],
    targetSelectors: ['[data-onboarding-target="project-switcher"]'],
    placement: "bottom",
  },
  {
    kicker: "个性化设置",
    title: "Settings：按你的习惯调整工作区",
    body: "点击左侧图标栏底部的头像，查看账户信息、用量或打开设置。需要改变外观或功能范围时，再打开 Settings。",
    points: [
      "在通用设置中切换亮色 / 暗色主题和界面语言",
      "按需显示或隐藏邮箱、研究流程等可选模块",
      "账户设置可以查看账号、订阅和剩余用量",
    ],
    targetSelectors: ['[data-onboarding-target="user-settings"]', '[data-onboarding-target="user-menu"]'],
    placement: "right",
  },
];

const EN_STEPS: OnboardingStep[] = [
  {
    kicker: "Navigation",
    title: "Left icon bar: switch between research workspaces",
    body: "Click the icons on the left to switch to Chat, Code, LaTeX, or Literature; the current module stays highlighted. Other features are in the More menu.",
    points: [
      "Chat: describe a task and follow the agent's progress and results",
      "Literature: search, organize, and cite research material",
      "Code / LaTeX: write programs, run experiments, and typeset papers",
      "More: open Workflows, Mail, and Settings",
    ],
    targetSelectors: ['[data-onboarding-target="module-navigation"]'],
    placement: "right",
  },
  {
    kicker: "Main workspace",
    title: "Chat: hand research tasks to the agent",
    body: "The center area shows the conversation, tool calls, results, and errors. Send your goals, materials, or error messages straight to Chat.",
    points: [
      "The sidebar groups past conversations under Pinned and Projects",
      "When the agent runs commands, the steps and a summary of changes appear here",
      "To pick up where you left off, return to the matching project and conversation",
    ],
    targetSelectors: ['[data-onboarding-target="workspace"]'],
    placement: "inside",
  },
  {
    kicker: "Current project",
    title: "Project switcher: tell the agent which folder to work in",
    body: "This control at the top sets the working directory. With the wrong project selected, the agent reads the wrong files, so check it before you start a task.",
    points: [
      "Click the project name at the top to open the project list",
      "Choose “Add local project…” at the bottom of the panel to add a folder",
      "Check the path under the project, or choose “Open project folder” to confirm the folder",
    ],
    targetSelectors: ['[data-onboarding-target="project-switcher"]'],
    placement: "bottom",
  },
  {
    kicker: "Personalization",
    title: "Settings: tailor the workspace to how you work",
    body: "Click the avatar at the bottom of the left icon bar to see account details and usage, or to open Settings. Open Settings whenever you want to change the appearance or the available features.",
    points: [
      "Switch between light and dark themes and change the interface language in General",
      "Show or hide optional modules such as Mail and Workflows",
      "Account shows your account, subscription, and remaining usage",
    ],
    targetSelectors: ['[data-onboarding-target="user-settings"]', '[data-onboarding-target="user-menu"]'],
    placement: "right",
  },
];

const ES_STEPS: OnboardingStep[] = [
  {
    kicker: "Navegación",
    title: "Barra de iconos izquierda: cambia de espacio de investigación",
    body: "Haz clic en los iconos de la izquierda para ir a Chat, Código, LaTeX o Literatura; el módulo actual queda resaltado. Las demás funciones están en el menú Más.",
    points: [
      "Chat: plantea una tarea y sigue el progreso y los resultados del agente",
      "Literatura: busca, organiza y cita material de investigación",
      "Código / LaTeX: escribe programas, ejecuta experimentos y compón artículos",
      "Más: abre Flujos de trabajo, Correo y Configuración",
    ],
    targetSelectors: ['[data-onboarding-target="module-navigation"]'],
    placement: "right",
  },
  {
    kicker: "Espacio principal",
    title: "Chat: encarga tareas de investigación al agente",
    body: "La zona central muestra la conversación, las llamadas a herramientas, los resultados y los errores. Envía tus objetivos, materiales o mensajes de error directamente al chat.",
    points: [
      "La barra lateral agrupa las conversaciones en Fijadas y Proyectos",
      "Cuando el agente ejecuta comandos, aquí aparecen los pasos y un resumen de los cambios",
      "Para retomar el trabajo, vuelve al proyecto y la conversación correspondientes",
    ],
    targetSelectors: ['[data-onboarding-target="workspace"]'],
    placement: "inside",
  },
  {
    kicker: "Proyecto actual",
    title: "Selector de proyecto: indica al agente en qué carpeta trabajar",
    body: "Este control de la parte superior fija el directorio de trabajo. Si eliges el proyecto equivocado, el agente leerá archivos equivocados, así que compruébalo antes de empezar una tarea.",
    points: [
      "Haz clic en el nombre del proyecto, arriba, para abrir la lista de proyectos",
      "Elige «Añadir proyecto local…» al final del panel para añadir una carpeta",
      "Revisa la ruta bajo el proyecto o elige «Abrir carpeta del proyecto» para confirmarla",
    ],
    targetSelectors: ['[data-onboarding-target="project-switcher"]'],
    placement: "bottom",
  },
  {
    kicker: "Personalización",
    title: "Configuración: adapta el espacio de trabajo a tu manera",
    body: "Haz clic en el avatar al final de la barra de iconos izquierda para ver tu cuenta y tu uso, o para abrir la configuración. Ábrela cuando quieras cambiar la apariencia o las funciones disponibles.",
    points: [
      "En General, cambia entre tema claro y oscuro y elige el idioma de la interfaz",
      "Muestra u oculta módulos opcionales como Correo y Flujos de trabajo",
      "En Cuenta verás tu cuenta, tu suscripción y el uso restante",
    ],
    targetSelectors: ['[data-onboarding-target="user-settings"]', '[data-onboarding-target="user-menu"]'],
    placement: "right",
  },
];

const ONBOARDING_STEPS: Record<Language, OnboardingStep[]> = { cn: CN_STEPS, en: EN_STEPS, es: ES_STEPS };

const ONBOARDING_COPY: Record<Language, { progress: (label: string) => string; back: string; skip: string; next: string; start: string }> = {
  cn: { progress: (label) => `教程进度：${label}`, back: "上一步", skip: "跳过", next: "下一步", start: "开始使用" },
  en: { progress: (label) => `Tutorial progress: ${label}`, back: "Back", skip: "Skip", next: "Next", start: "Get started" },
  es: { progress: (label) => `Progreso del tutorial: ${label}`, back: "Atrás", skip: "Omitir", next: "Siguiente", start: "Empezar" },
};

function readSeenFlag() {
  if (typeof window === "undefined") return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("typesetPreview") === "1" || params.get("tab") != null || params.get("settings") != null || params.get("settingsTab") != null) {
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
  const language = useStore((s) => s.language);
  const steps = ONBOARDING_STEPS[language];
  const copy = ONBOARDING_COPY[language];
  const [open, setOpen] = useState(() => !readSeenFlag());
  const [index, setIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const step = steps[index];
  const isFirstStep = index === 0;
  const isLastStep = index === steps.length - 1;
  const progressLabel = useMemo(
    () => `${index + 1} / ${steps.length}`,
    [index, steps.length],
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
    setIndex((current) => Math.min(current + 1, steps.length - 1));
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
        <div className="onboarding-progress" aria-label={copy.progress(progressLabel)}>
          {steps.map((item, itemIndex) => (
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
            {copy.back}
          </button>
          <button type="button" className="onboarding-skip" onClick={close}>
            {copy.skip}
          </button>
          <button type="button" className="primary" onClick={next}>
            {isLastStep ? copy.start : copy.next}
          </button>
        </div>
      </section>
    </div>
  );
}
