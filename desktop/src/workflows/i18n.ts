import { languageLocale, languagePromptName, type Language } from "../language";
import { useStore } from "../store";
import { COMMON_COPY, type CommonCopy } from "./copy/common";
import { ENGINE_COPY, type EngineCopy } from "./copy/engine";
import { HOME_COPY, type HomeCopy } from "./copy/home";
import { PANELS_COPY, type PanelsCopy } from "./copy/panels";
import { RUN_COPY, type RunCopy } from "./copy/run";
import { STAGES_COPY, type StagesCopy } from "./copy/stages";

/**
 * All user-visible copy of the Workflows page, per UI language.
 *
 * The sections follow the file they serve: `common` holds the status, phase and
 * stage vocabularies every panel shares; `panels` and `stages` the stage
 * workspaces; `home` and `run` the workflow controller (notices, errors and the
 * event-log lines it persists); `engine` the pure workflow engine and the
 * persistence migrations.
 *
 * Model prompts are not copy. Their instructions stay as written; only the
 * language a model is asked to answer in follows the UI (`workflowOutputLanguage`).
 */
export interface WorkflowsCopy {
  common: CommonCopy;
  panels: PanelsCopy;
  stages: StagesCopy;
  home: HomeCopy;
  run: RunCopy;
  engine: EngineCopy;
}

function bundle(language: Language): WorkflowsCopy {
  return {
    common: COMMON_COPY[language],
    panels: PANELS_COPY[language],
    stages: STAGES_COPY[language],
    home: HOME_COPY[language],
    run: RUN_COPY[language],
    engine: ENGINE_COPY[language],
  };
}

export const WORKFLOWS_COPY: Record<Language, WorkflowsCopy> = {
  cn: bundle("cn"),
  en: bundle("en"),
  es: bundle("es"),
};

/** The UI language right now, for code that runs outside React render. */
export function currentWorkflowLanguage(): Language {
  return useStore.getState().language;
}

/** Copy for non-component code (handlers, helpers, persisted event lines). */
export function workflowsCopy(language: Language = currentWorkflowLanguage()): WorkflowsCopy {
  return WORKFLOWS_COPY[language];
}

/** Copy for components; re-renders when the UI language changes. */
export function useWorkflowsCopy(): WorkflowsCopy {
  return WORKFLOWS_COPY[useStore((state) => state.language)];
}

/** BCP 47 locale for dates and numbers on the Workflows page. */
export function workflowsLocale(language: Language = currentWorkflowLanguage()): string {
  return languageLocale(language);
}

/**
 * The output-language sentence appended to model prompts whose free-text fields
 * (summary, issues, rationale, …) are shown to the user. The prompt body keeps
 * its original wording; JSON keys, ids and search strings stay as specified.
 */
export function workflowOutputLanguage(language: Language = currentWorkflowLanguage()): string {
  return `所有自然语言字段（如 summary、issues、rationale、说明文字）使用 ${languagePromptName(language)} 撰写；JSON 键名、枚举值、ID 和检索式保持原样。`;
}

/**
 * Wraps a per-language table so existing `TABLE[key]` call sites read the
 * current UI language at access time instead of a value frozen at import.
 */
export function liveCopy<T extends object>(pick: (copy: WorkflowsCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, key) => (pick(workflowsCopy()) as Record<PropertyKey, unknown>)[key],
    has: (_target, key) => key in pick(workflowsCopy()),
    ownKeys: () => Reflect.ownKeys(pick(workflowsCopy())),
    getOwnPropertyDescriptor: (_target, key) => {
      const value = (pick(workflowsCopy()) as Record<PropertyKey, unknown>)[key];
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
  });
}

/** Stage title in the UI language; Chinese keeps the title the run persisted. */
export function stageTitle(stage: { id: string; title: string }, copy: WorkflowsCopy = workflowsCopy()): string {
  return copy.common.stageText[stage.id]?.title ?? stage.title;
}

/** Stage description in the UI language; Chinese keeps the persisted text. */
export function stageDescription(
  stage: { id: string; description?: string },
  copy: WorkflowsCopy = workflowsCopy(),
): string {
  return copy.common.stageText[stage.id]?.description ?? stage.description ?? "";
}
