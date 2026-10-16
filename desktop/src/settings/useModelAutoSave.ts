import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { configSet, isTauri } from "../api/tauri";
import type { ConfigPatch, ConfigView } from "../types";
import { useStore, type Language } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { notifyChatModelsUpdated } from "../modelEvents";

const MODEL_FIELDS = ["summarizerProvider", "summarizerModel", "summarizerBaseUrl", "retrievalCardModel", "webProxyUrl"] as const;
type SecretField = "summarizerApiKey" | "scopusApiKey" | "braveSearchApiKey" | "exaApiKey";
interface SecretDraft {
  field: SecretField;
  present: "hasSummarizerKey" | "hasScopusKey" | "hasBraveSearchKey" | "hasExaKey";
  masked: "summarizerKeyMasked" | "scopusKeyMasked" | "braveSearchKeyMasked" | "exaKeyMasked";
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
}
interface Params {
  configView: ConfigView | null;
  setConfigView: Dispatch<SetStateAction<ConfigView | null>>;
  draft: ConfigPatch;
  setDraft: Dispatch<SetStateAction<ConfigPatch>>;
  secrets: SecretDraft[];
  language: Language;
}

/** Commit only edited Models fields; unrelated preferences and newer drafts stay intact. */
export function useModelAutoSave(params: Params) {
  const latest = useRef(params);
  latest.current = params;
  const pending = useRef(false);
  const failedSnapshot = useRef<string | null>(null);
  const mounted = useRef(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const patch: ConfigPatch = {};
  if (params.configView) {
    for (const field of MODEL_FIELDS) {
      const value = params.draft[field];
      if (value !== undefined && value !== (params.configView[field] ?? "")) patch[field] = value;
    }
    for (const secret of params.secrets) {
      if (secret.value.trim()) patch[secret.field] = secret.value.trim();
    }
  }
  // This snapshot stays in memory, including pending secret edits; never log it.
  const snapshot = JSON.stringify(patch);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (snapshot === "{}") {
      failedSnapshot.current = null;
      setError("");
      return;
    }
    if (pending.current || failedSnapshot.current === snapshot) return;
    const commit = async (encoded = snapshot) => {
      const submitted: ConfigPatch = JSON.parse(encoded);
      pending.current = true;
      if (mounted.current) setError("");
        try {
          const current = latest.current;
          let confirmed: ConfigView;
          if (isTauri()) {
            confirmed = await configSet(submitted);
          } else {
            confirmed = { ...current.configView! };
            for (const field of MODEL_FIELDS) {
              if (submitted[field] !== undefined) confirmed[field] = submitted[field];
            }
            for (const secret of current.secrets) {
              if (submitted[secret.field] !== undefined) {
                confirmed[secret.present] = true;
                confirmed[secret.masked] = "••••";
              }
            }
          }
          notifyChatModelsUpdated();
          if (!mounted.current) return;
          let updates: Partial<ConfigView> = {};
          for (const field of MODEL_FIELDS) {
            if (submitted[field] !== undefined) updates = { ...updates, [field]: confirmed[field] };
          }
          for (const secret of latest.current.secrets) {
            const value = submitted[secret.field];
            if (value === undefined) continue;
            updates = { ...updates, [secret.present]: confirmed[secret.present], [secret.masked]: confirmed[secret.masked] };
            secret.setValue((draft) => draft.trim() === value ? "" : draft);
          }
          latest.current.setConfigView((view) => view ? { ...view, ...updates } : view);
          latest.current.setDraft((draft) => {
            const next = { ...draft };
            for (const field of MODEL_FIELDS) {
              if (submitted[field] !== undefined && draft[field] === submitted[field]) next[field] = confirmed[field] ?? "";
            }
            return next;
          });
          failedSnapshot.current = null;
        } catch (failure) {
          failedSnapshot.current = encoded;
          const message = formatUserFacingError(failure, latest.current.language);
          if (mounted.current) setError(message);
          else useStore.getState().setError(message);
        } finally {
          pending.current = false;
          // Pick up edits made while this request was pending, without overlapping writes.
          if (mounted.current) setRevision((value) => value + 1);
          else if (latestSnapshot.current !== "{}" && latestSnapshot.current !== encoded && failedSnapshot.current !== latestSnapshot.current) {
            void commit(latestSnapshot.current);
          }
        }
    };
    const timer = window.setTimeout(() => void commit(), 500);
    return () => {
      window.clearTimeout(timer);
      // Leaving Settings must not discard an edit made just before navigation.
      if (!mounted.current && !pending.current) void commit();
    };
  }, [snapshot, revision]);

  return { error, retry: () => { failedSnapshot.current = null; setRevision((value) => value + 1); } };
}
