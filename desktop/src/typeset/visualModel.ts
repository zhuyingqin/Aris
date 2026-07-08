/** Shared types for the Typeset visual editor (block editor + CodeMirror editor). */

/** Where the compiled-PDF cursor maps back to in the source, for sync-scroll. */
export type VisualPdfCursor = {
  line: number;
  start: number;
  end: number;
  text: string;
};
