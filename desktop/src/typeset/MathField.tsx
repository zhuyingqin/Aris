import { useEffect, useRef, useCallback, useState } from "react";
import type { MathfieldElement } from "mathlive";

let mfRegistered = false;
let mfRegistrationPromise: Promise<boolean> | null = null;

function ensureMathfieldRegistered(): Promise<boolean> {
  if (mfRegistered) return Promise.resolve(true);
  if (mfRegistrationPromise) return mfRegistrationPromise;
  const registry = globalThis.customElements;
  if (!registry || registry.get("math-field")) {
    mfRegistered = Boolean(registry?.get("math-field"));
    return Promise.resolve(mfRegistered);
  }
  mfRegistrationPromise = import("mathlive")
    .then((mod) => {
      const MFE = mod.MathfieldElement;
      if (!registry.get("math-field")) {
        registry.define("math-field", MFE);
      }
      mfRegistered = true;
      return true;
    })
    .catch(() => {
      mfRegistered = false;
      return false;
    })
    .finally(() => {
      mfRegistrationPromise = null;
    });
  return mfRegistrationPromise;
}

function setMathFieldValue(node: MathfieldElement | null, value: string) {
  if (!node || typeof node.setValue !== "function") return;
  try {
    node.setValue(value.trim(), { silenceNotifications: true });
  } catch {
    // mathlive may throw on malformed LaTeX; ignore
  }
}

interface MathFieldProps {
  value: string;
  onChange: (latex: string) => void;
  className?: string;
  readOnly?: boolean;
}

export default function MathField({ value, onChange, className, readOnly }: MathFieldProps) {
  const ref = useRef<MathfieldElement | null>(null);
  const lastEmitted = useRef(value);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let disposed = false;
    ensureMathfieldRegistered().then((ready) => {
      if (disposed) return;
      setFallback(!ready);
      if (ready) setMathFieldValue(ref.current, value);
    });
    return () => {
      disposed = true;
    };
  }, [value]);

  useEffect(() => {
    const mf = ref.current;
    if (!mf) return;
    const trimmed = value.trim();
    if (trimmed === lastEmitted.current.trim()) return;
    setMathFieldValue(mf, trimmed);
    lastEmitted.current = trimmed;
  }, [value]);

  const handleInput = useCallback(() => {
    const mf = ref.current;
    if (!mf) return;
    const latex = mf.getValue("latex-expanded").trim();
    if (latex === lastEmitted.current.trim()) return;
    lastEmitted.current = latex;
    onChange(latex);
  }, [onChange]);

  const handleRef = useCallback((node: MathfieldElement | null) => {
    if (ref.current) {
      ref.current.removeEventListener("input", handleInput);
    }
    ref.current = node;
    if (node) {
      setMathFieldValue(node, value);
      void ensureMathfieldRegistered().then((ready) => {
        setFallback(!ready);
        if (ready) setMathFieldValue(node, value);
      });
      node.addEventListener("input", handleInput);
    }
  }, [handleInput, value]);

  if (fallback) {
    return (
      <textarea
        className={className}
        value={value}
        readOnly={readOnly}
        rows={Math.max(2, value.split("\n").length)}
        spellCheck={false}
        aria-label="Edit math"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  return (
    <math-field
      ref={handleRef}
      class={className}
      read-only={readOnly ? "" : undefined}
      style={{
        display: "block",
        width: "100%",
        minHeight: "40px",
        font: "20px/1.45 'Times New Roman', Times, serif",
        padding: "8px 10px",
        border: "1px solid var(--visual-border, #d8d8d8)",
        borderRadius: "2px",
        background: "var(--visual-widget-bg, #fafafa)",
        color: "var(--visual-text, #000)",
        caretColor: "var(--visual-text, #000)",
      }}
    />
  );
}
