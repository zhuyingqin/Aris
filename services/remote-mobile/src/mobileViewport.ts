const SOFTWARE_KEYBOARD_MIN_INSET_PX = 120;

export interface SoftwareKeyboardMetrics {
  inputFocused: boolean;
  baselineHeight: number;
  visibleBottom: number;
}

/**
 * Distinguishes a software keyboard from small browser-toolbar and safe-area
 * changes. The baseline is captured while the composer is not focused.
 */
export function isSoftwareKeyboardOpen(metrics: SoftwareKeyboardMetrics): boolean {
  return metrics.inputFocused &&
    metrics.baselineHeight - metrics.visibleBottom >= SOFTWARE_KEYBOARD_MIN_INSET_PX;
}
