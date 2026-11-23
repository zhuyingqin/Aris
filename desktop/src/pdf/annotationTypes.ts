// Marks drawn on a PDF page. The reader owns their shape; the literature
// store persists them per attachment.

/** How a quote was read off the page: its text layer or the page image. */
export type EvidenceSource = "text" | "vision";

export type PdfAnnotationKind = "core" | "evidence" | "answer-support" | "note";
export type PdfAnnotationColor = "yellow" | "green" | "blue" | "red" | "purple";
/** Visual treatment of a mark. Absent = "highlight" (back-compat with older records). */
export type PdfAnnotationStyle = "highlight" | "underline" | "strikethrough";

export interface PdfAnnotationRect {
  /** Normalized coordinates relative to the rendered PDF page. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  /** Normalized parent attachment item, when the annotation belongs to a PDF child. */
  attachmentId?: string;
  page: number;
  pageLabel?: string;
  quote: string;
  note: string;
  kind: PdfAnnotationKind;
  annotationType?: string;
  color?: PdfAnnotationColor;
  style?: PdfAnnotationStyle;
  rects?: PdfAnnotationRect[];
  position?: unknown;
  sortIndex?: number;
  author?: string;
  isExternal?: boolean;
  source?: EvidenceSource;
  imageFingerprint?: string;
  /** Id of the Brief section, evidence item, or answer chain that created it. */
  sourceId?: string;
  /** Evidence item that directly grounds an answer-support annotation. */
  evidenceId?: string;
  sourcePayload?: unknown;
  createdAt: string;
}
