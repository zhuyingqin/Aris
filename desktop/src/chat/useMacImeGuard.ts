import { useEffect, useRef, type KeyboardEvent } from "react";
import { isMacOS } from "../platform";

/** Keep macOS input-method keystrokes out of submit and autocomplete shortcuts. */
export function useMacImeGuard() {
  const composing = useRef(false);
  const commitPending = useRef(false);
  const imeEnterHeld = useRef(false);
  const commitTimer = useRef<number | null>(null);

  const clearCommitTimer = () => {
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = null;
  };

  useEffect(() => () => {
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
  }, []);

  return {
    onCompositionStart: () => {
      if (!isMacOS()) return;
      clearCommitTimer();
      commitPending.current = false;
      composing.current = true;
    },
    onCompositionEnd: () => {
      if (!isMacOS()) return;
      composing.current = false;
      // WKWebView can end composition before dispatching its confirming Enter,
      // with isComposing already false. Retain the boundary for this event turn.
      commitPending.current = true;
      clearCommitTimer();
      commitTimer.current = window.setTimeout(() => {
        commitPending.current = false;
        commitTimer.current = null;
      }, 0);
    },
    onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isMacOS() || event.key !== "Enter") return;
      imeEnterHeld.current = false;
      commitPending.current = false;
    },
    onBlur: () => {
      clearCommitTimer();
      composing.current = false;
      commitPending.current = false;
      imeEnterHeld.current = false;
    },
    isImeKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isMacOS()) return false;
      const imeKey = composing.current
        || event.nativeEvent.isComposing
        || event.nativeEvent.keyCode === 229
        || (event.key === "Enter" && (commitPending.current || (event.repeat && imeEnterHeld.current)));
      if (event.key === "Enter") imeEnterHeld.current = imeKey;
      return imeKey;
    },
  };
}
