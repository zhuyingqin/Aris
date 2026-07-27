import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyBinding } from "@codemirror/view";

import {
  fileReadText,
  fileWriteText,
  isTauri,
  labExecuteFile,
  labInspectFileVars,
  onLabFileOutput,
  type FileText,
} from "../api/tauri";
import CodeEditor from "./CodeEditor";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { useStore } from "../store";
import { LAB_COPY } from "./i18n";
import {
  basename,
  detectExternalFileChange,
  editorSelectionOrLine,
  languageForPath,
  normalizePath,
  runtimeChoiceForLanguage,
} from "./labEditorCore";
import { OutputGroup } from "./outputs";
import type {
  CellOutput,
  FileExecutionResult,
  KernelSpecInfo,
  LabFileOutputEvent,
  VariableInfo,
  VariablesResult,
} from "./labTypes";
import { diffTextLines } from "./textDiff";

type FileRunStatus = "idle" | "running" | "ok" | "error" | "timeout";
const FILE_POLL_MS = 1800;

function VariableRow({ variable }: { variable: VariableInfo }) {
  const shape = variable.shape?.length ? variable.shape.join(" x ") : null;
  return (
    <div className="lab-file-var-row">
      <div className="lab-file-var-main">
        <span className="lab-var-name">{variable.name}</span>
        <span className="lab-var-type">{variable.type}</span>
        {shape && <span className="lab-var-shape">{shape}</span>}
      </div>
      <div className="lab-var-repr" title={variable.repr}>
        {variable.repr}
      </div>
    </div>
  );
}

type FileToolIconName =
  | "clear"
  | "refresh"
  | "run";

function FileToolIcon({ name }: { name: FileToolIconName }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      {name === "clear" && (
        <path
          d="M3.4 4.4h9.2M6 4.4V3.2h4v1.2M5 6.2l.4 6.1h5.2l.4-6.1"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {name === "refresh" && (
        <path
          d="M12.6 5.5A5 5 0 1 0 13 8M12.6 2.8v2.7h-2.7"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {name === "run" && <path d="M5.1 3.2 12.2 8l-7.1 4.8z" fill="currentColor" />}
    </svg>
  );
}

interface Props {
  path: string;
  kernelspecs: KernelSpecInfo[];
  selectedKernel: string | null;
  onSelectKernel: (name: string) => void;
  /** Report unsaved-edit state up to Lab so the editor tab can show a dirty dot. */
  onDirtyChange?: (path: string, dirty: boolean) => void;
}

export default function FileEditorPane({
  path,
  kernelspecs,
  selectedKernel,
  onSelectKernel,
  onDirtyChange,
}: Props) {
  const uiLanguage = useStore((s) => s.language);
  const copy = LAB_COPY[uiLanguage];
  const [loaded, setLoaded] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<CellOutput[]>([]);
  const [runStatus, setRunStatus] = useState<FileRunStatus>("idle");
  const [runLabel, setRunLabel] = useState("Python output");
  const [kernelName, setKernelName] = useState<string | null>(null);
  const [variables, setVariables] = useState<VariableInfo[]>([]);
  const [variablesBusy, setVariablesBusy] = useState(false);
  const [reviewBase, setReviewBase] = useState<string | null>(null);
  const [externalChangePending, setExternalChangePending] = useState(false);
  const editorRef = useRef<SharedEditorHandle | null>(null);
  const draftRef = useRef("");
  const loadedRef = useRef<FileText | null>(null);
  const reviewBaseRef = useRef<string | null>(null);
  const savingRef = useRef(false);

  const language = useMemo(() => languageForPath(path), [path]);
  const isPython = language === "python";
  const dirty = Boolean(loaded && draft !== loaded.content);
  const reviewDiffLines = useMemo(
    () => externalChangePending && reviewBase !== null ? diffTextLines(reviewBase, draft) : [],
    [draft, externalChangePending, reviewBase],
  );
  const reviewAdded = reviewDiffLines.filter((line) => line.type === "added").length;
  const removedReviewLines = reviewDiffLines.filter((line) => line.type === "removed");
  const reviewRemoved = removedReviewLines.length;
  const running = runStatus === "running";
  const { runtimeSpecs, activeRuntime, activeSpec } = useMemo(
    () => runtimeChoiceForLanguage(kernelspecs, selectedKernel, language),
    [kernelspecs, language, selectedKernel],
  );

  // Surface unsaved state to Lab's tab strip; report clean on unmount / path
  // switch (only the active file editor is mounted, so its draft is discarded
  // when it unmounts and the tab should no longer read as dirty).
  useEffect(() => {
    onDirtyChange?.(path, dirty);
    return () => onDirtyChange?.(path, false);
  }, [path, dirty, onDirtyChange]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);
  useEffect(() => {
    reviewBaseRef.current = reviewBase;
  }, [reviewBase]);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);
    setDraft("");
    setOutputs([]);
    setVariables([]);
    setRunStatus("idle");
    setKernelName(null);
    setReviewBase(null);
    setExternalChangePending(false);
    fileReadText(path)
      .then((file) => {
        if (cancelled) return;
        setLoaded(file);
        setDraft(file.content);
        setReviewBase(file.content);
      })
      .catch((readError) => {
        if (cancelled) return;
        setError(String(readError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!loaded || loading) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || savingRef.current) return;
      void fileReadText(path)
        .then((file) => {
          if (cancelled || savingRef.current) return;
          const current = loadedRef.current;
          const change = detectExternalFileChange({
            currentLoadedContent: current?.content ?? null,
            incomingContent: file.content,
            draft: draftRef.current,
            reviewBase: reviewBaseRef.current,
            saving: savingRef.current,
          });
          if (!change) return;
          setLoaded(file);
          setReviewBase(change.reviewBase);
          setDraft(change.draft);
          setExternalChangePending(true);
        })
        .catch(() => undefined);
    }, FILE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loaded, loading, path]);

  useEffect(() => {
    if (!isTauri() || !isPython) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const currentPath = normalizePath(path);
    void onLabFileOutput<LabFileOutputEvent>((event) => {
      if (normalizePath(event.filePath) !== currentPath) return;
      if ((event.output as { type?: string })?.type === "clear") {
        setOutputs([]);
        return;
      }
      setOutputs((items) => [...items, event.output]);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [path, isPython]);

  const save = async (): Promise<boolean> => {
    if (!loaded) return false;
    if (!dirty) return true;
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      const file = loaded.version
        ? await fileWriteText(path, draft, loaded.version)
        : await fileWriteText(path, draft);
      setLoaded(file);
      setDraft(file.content);
      setReviewBase(file.content);
      setExternalChangePending(false);
      return true;
    } catch (writeError) {
      setError(String(writeError));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const keepExternalChange = () => {
    if (!loaded) return;
    setReviewBase(loaded.content);
    setExternalChangePending(false);
  };

  const revertExternalChange = async () => {
    if (!loaded || reviewBase === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const file = loaded.version
        ? await fileWriteText(path, reviewBase, loaded.version)
        : await fileWriteText(path, reviewBase);
      setLoaded(file);
      setDraft(file.content);
      setReviewBase(file.content);
      setExternalChangePending(false);
    } catch (writeError) {
      setError(String(writeError));
    } finally {
      setSaving(false);
    }
  };

  const runPython = async (scope: "file" | "selection") => {
    if (!isPython || running || loading || !loaded) return;
    const code = scope === "selection" ? editorSelectionOrLine(draft, editorRef.current) : undefined;
    if (scope === "selection" && !code?.trim()) return;
    if (scope === "file" && !(await save())) return;

    setRunStatus("running");
    setRunLabel(scope === "file" ? copy.runPythonFileTitle : copy.runSelectionLineLabel);
    setOutputs([]);
    setError(null);
    try {
      const result = await labExecuteFile<FileExecutionResult>(path, {
        code,
        kernel: activeRuntime ?? undefined,
      });
      setOutputs(result.outputs ?? []);
      setRunStatus(result.status);
      setKernelName(result.kernelName ?? activeRuntime ?? null);
    } catch (runError) {
      setRunStatus("error");
      setError(String(runError));
    }
  };

  const inspectVariables = async () => {
    if (!isPython || running) return;
    setVariablesBusy(true);
    setError(null);
    try {
      const result = await labInspectFileVars<VariablesResult>(path, activeRuntime ?? undefined);
      setVariables(result.variables ?? []);
      setKernelName(activeRuntime ?? null);
    } catch (inspectError) {
      setError(String(inspectError));
    } finally {
      setVariablesBusy(false);
    }
  };

  // Stable refs so the keymap (captured once by CodeEditor at mount, see its
  // "extensions are creation-time only" contract) always calls the *latest*
  // isPython/runPython instead of closing over the values from first render.
  const isPythonRef = useRef(isPython);
  isPythonRef.current = isPython;
  const runSelectionRef = useRef<() => void>(() => undefined);
  runSelectionRef.current = () => void runPython("selection");
  const saveRef = useRef<() => void>(() => undefined);
  saveRef.current = () => void save();
  const extraKeymapRef = useRef<KeyBinding[]>([
    {
      key: "Shift-Enter",
      run: () => {
        if (!isPythonRef.current) return false;
        runSelectionRef.current();
        return true;
      },
    },
    { key: "Mod-s", run: () => { saveRef.current(); return true; } },
  ]);

  return (
    <div className="lab-file-editor">
      <div className="lab-file-editor-bar">
        <div className="lab-file-editor-title">
          <strong>{basename(path)}</strong>
          <span title={path}>{path}</span>
        </div>
        <div className="lab-file-editor-actions">
          <span className="lab-file-editor-lang">{language}</span>
          {isPython && (
            <button
              className="lab-file-tool primary lab-run-file-btn"
              type="button"
              disabled={loading || saving || running || !loaded}
              onClick={() => void runPython("file")}
              title={copy.runPythonFileTitle}
              aria-label={copy.runPythonFileTitle}
            >
              <FileToolIcon name="run" />
            </button>
          )}
        </div>
      </div>
      {externalChangePending && (
        <div className="lab-file-review-bar" role="status" aria-live="polite">
          <div>
            <strong>{copy.aiChangesDetected}</strong>
            <span aria-label={copy.linesChangedAria(reviewAdded, reviewRemoved)}>
              {reviewAdded > 0 ? `+${reviewAdded}` : "+0"} {reviewRemoved > 0 ? `-${reviewRemoved}` : "-0"}
            </span>
            {removedReviewLines.length > 0 && (
              <div className="lab-file-review-removed">
                {removedReviewLines.slice(0, 3).map((line, index) => (
                  <code key={`${line.line}:${index}`}>- {line.text || " "}</code>
                ))}
                {removedReviewLines.length > 3 && <em>{copy.moreRemovedLines(removedReviewLines.length - 3)}</em>}
              </div>
            )}
          </div>
          <div className="lab-file-review-actions">
            <button className="lab-btn primary" type="button" onClick={keepExternalChange} disabled={saving} title={copy.keepAiChangesTitle}>
              {copy.keepAiChanges}
            </button>
            <button className="lab-btn" type="button" onClick={() => void revertExternalChange()} disabled={saving} title={copy.restoreFileTitle}>
              {copy.restoreLabel}
            </button>
          </div>
        </div>
      )}

      {isPython && (
        <div className="lab-file-runtime-strip">
          <select
            className="lab-select lab-kernel-picker"
            value={activeRuntime ?? ""}
            disabled={running || runtimeSpecs.length === 0}
            onChange={(event) => onSelectKernel(event.target.value)}
            title={copy.selectInterpreterKernelTitle}
          >
            {runtimeSpecs.length === 0 ? (
              <option value="" disabled>
                {copy.noKernelsFound}
              </option>
            ) : (
              runtimeSpecs.map((spec) => (
                <option key={spec.name} value={spec.name}>
                  {spec.displayName}
                </option>
              ))
            )}
          </select>
          <span className={kernelName ? "lab-file-kernel on" : "lab-file-kernel"}>
            <span className="lab-dot" />
            {kernelName ?? activeSpec?.displayName ?? selectedKernel ?? copy.noInterpreter}
          </span>
        </div>
      )}

      {error && (
        <div className="lab-file-editor-error">
          <strong>{copy.cannotCompleteAction}</strong>
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="lab-empty">{copy.loadingFile}</div>
      ) : loaded ? (
        <CodeEditor
          value={draft}
          language={language}
          onChange={setDraft}
          diffLines={reviewDiffLines}
          extraKeymap={extraKeymapRef.current}
          onReady={(handle) => {
            editorRef.current = handle;
          }}
          placeholder={copy.startTypingPlaceholder}
          readOnly={saving}
          wrap={false}
          dataEditor="file"
        />
      ) : !error ? (
        <div className="lab-empty">{copy.selectFileToOpenHint}</div>
      ) : null}

      {isPython && (
        <div className="lab-file-runtime">
          <section className="lab-file-output-panel">
            <div className="lab-file-panel-head">
              <div>
                <strong>{copy.outputLabel}</strong>
                <span>{runStatus === "idle" ? copy.readyLabel : `${runLabel}: ${runStatus}`}</span>
              </div>
              <button
                className="lab-file-tool"
                type="button"
                disabled={running || outputs.length === 0}
                onClick={() => setOutputs([])}
                title={copy.clearOutputTitle}
                aria-label={copy.clearOutputTitle}
              >
                <FileToolIcon name="clear" />
              </button>
            </div>
            <div className="lab-file-output-body">
              {outputs.length === 0 ? (
                <div className="lab-muted">{copy.runToSeeOutputHint}</div>
              ) : (
                <OutputGroup outputs={outputs} />
              )}
            </div>
          </section>

          <section className="lab-file-vars-panel">
            <div className="lab-file-panel-head">
              <div>
                <strong>{copy.variablesLabel}</strong>
                <span>{variables.length ? copy.liveCount(variables.length) : copy.kernelScopeLabel}</span>
              </div>
              <button
                className="lab-file-tool"
                type="button"
                disabled={running || variablesBusy}
                onClick={() => void inspectVariables()}
                title={copy.refreshVariablesTitle}
                aria-label={copy.refreshVariablesTitle}
              >
                <FileToolIcon name="refresh" />
              </button>
            </div>
            <div className="lab-file-vars-body">
              {variables.length === 0 ? (
                <div className="lab-muted">{copy.noVariablesCaptured}</div>
              ) : (
                variables.map((variable) => <VariableRow key={variable.name} variable={variable} />)
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
