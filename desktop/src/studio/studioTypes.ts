export type StudioArtifactKind = "slides" | "poster" | "web";
export type StudioArtifactStatus = "draft" | "ready" | "failed" | "generating" | "compiling";
export type StudioOrientation = "landscape" | "portrait";
export type StudioPageReviewStatus = "open" | "submitted" | "resolved";

export interface StudioPageReview {
  id: string;
  page: number;
  body: string;
  status: StudioPageReviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StudioArtifact {
  id: string;
  kind: StudioArtifactKind;
  title: string;
  sourcePaperDir?: string;
  status: StudioArtifactStatus;
  texPath?: string;
  pdfPath?: string;
  pptxPath?: string;
  svgPath?: string;
  htmlPath?: string;
  speakerNotesPath?: string;
  venue?: string;
  size?: string;
  orientation?: StudioOrientation;
  generatedAt: string;
  pinned: boolean;
  notes: string;
  pageReviews: StudioPageReview[];
}

export interface StudioLibrary {
  version: 1;
  artifacts: StudioArtifact[];
}

export const emptyStudioLibrary = (): StudioLibrary => ({
  version: 1,
  artifacts: [],
});
