import { useRef, useState } from "react";
import { formatUserFacingError } from "../errorMessage";
import { useStore } from "../store";

export type PreferenceSaveState = "idle" | "saving" | "saved" | "error";
type Feedback = { state: PreferenceSaveState; error: string };

/** Owned by Settings so feedback and retry targets survive category changes. */
export function usePreferenceSave() {
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const pending = useRef(new Set<string>());
  const retries = useRef(new Map<string, () => void | Promise<void>>());

  const save = async (key: string, operation: () => void | Promise<void>) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    retries.current.set(key, operation);
    setFeedback((current) => ({ ...current, [key]: { state: "saving", error: "" } }));
    try {
      const result = operation();
      if (result) await result;
      retries.current.delete(key);
      setFeedback((current) => ({ ...current, [key]: { state: "saved", error: "" } }));
    } catch (error) {
      setFeedback((current) => ({ ...current, [key]: {
        state: "error", error: formatUserFacingError(error, useStore.getState().language),
      } }));
    } finally {
      pending.current.delete(key);
    }
  };

  return { feedback, save, retry: (key: string) => {
    const operation = retries.current.get(key);
    if (operation) void save(key, operation);
  } };
}

export type PreferenceSave = ReturnType<typeof usePreferenceSave>;
