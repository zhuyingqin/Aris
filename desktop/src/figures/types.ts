export interface ModelIdentity { model: string; provider: string; endpoint: string; transport: string; signature: string }
export interface FigureRequest {
  id: string; kind: string; role: string; identity: ModelIdentity; maxOutputTokens: number;
  status: string; startedAt: string; finishedAt: string | null; stopReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number; [key: string]: unknown } | null;
  error: string | null; durationMs: number;
}
export interface FigureVersion {
  index: number; hash: string; svgPath: string; pngPath: string; pdfPath: string;
  parentIndex?: number | null; svgEditId?: string | null;
  pngHash?: string;
  author: string; classification: string; textCount: number; vectorCount: number;
  reviewStatus: string; renderer: string; fontFingerprint: string; createdAt: string;
}
export interface FigureSvgEdit {
  id: string; baseVersion: number; baseHash: string; prompt: string;
  resultVersion: number | null; status: string; error: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface FigureReview {
  versionHash: string; structurePass: boolean; visualPass: boolean | null; issues: string[];
  receivedImages: boolean; evidenceHashes: string[]; rawResponse: string;
}
export interface FigureRun {
  schemaVersion: number; id: string; title: string; method: string; style: string;
  sourceMode: "import" | "generate"; sourceMime: string | null; sourceHash: string | null;
  status: string; outputLimit: number; executor: ModelIdentity; reviewer: ModelIdentity;
  executorVision: boolean; reviewerVision: boolean; revisionUsed: boolean;
  imageIdentity?: ModelIdentity | null;
  rasterVersions?: FigureRasterVersion[]; sourceRaster?: number | null; imageConfirmed?: boolean;
  pendingRasterEdit?: FigureRasterVersion | null;
  versions: FigureVersion[]; requests: FigureRequest[]; review: FigureReview | null;
  svgEdits?: FigureSvgEdit[];
  error: string | null; createdAt: string; updatedAt: string;
}
export interface FigureRasterVersion {
  index: number; hash: string; path: string; mimeType: string; width: number; height: number;
  parentHash: string | null; parentIndex?: number | null; prompt: string | null; maskPath: string | null; requestId: string | null; promptRequestId?: string | null; createdAt: string;
}
export interface FigureRasterDocument { dataUrl: string; hash: string; index: number; width: number; height: number; editPrompts?: string[]; resolvedPrompt?: string | null; promptModel?: string | null }
export interface FigureView { projectId: string; run: FigureRun; active: boolean; activeCount?: number }
export interface FigureDocument { svg: string | null; rawOutput?: string | null; sourceDataUrl: string | null; previewDataUrl: string | null }
export interface FigureConnections {
  executor: ModelIdentity; reviewer: ModelIdentity;
  executorModels?: string[]; reviewerModels?: string[];
  image: { enabled: boolean; available: boolean; model: string | null; models: string[] };
}
export interface PrepareFigure {
  projectId: string; id: string; title: string; method: string; style: string;
  sourceMode: "import" | "generate"; sourceBase64: string | null;
  model: string | null; reviewerModel: string | null; imageModel: string | null;
  confirmedRaster?: { id: string; index: number; hash: string };
}
