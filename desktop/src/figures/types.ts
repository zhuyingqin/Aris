export interface ModelIdentity { model: string; provider: string; endpoint: string; transport: string; signature: string }
export interface FigureRequest {
  id: string; kind: string; role: string; identity: ModelIdentity; maxOutputTokens: number;
  status: string; startedAt: string; finishedAt: string | null; stopReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number; [key: string]: unknown } | null;
  error: string | null; durationMs: number;
}
export interface FigureVersion {
  index: number; hash: string; svgPath: string; pngPath: string; pdfPath: string;
  pngHash?: string;
  author: string; classification: string; textCount: number; vectorCount: number;
  reviewStatus: string; renderer: string; fontFingerprint: string; createdAt: string;
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
  versions: FigureVersion[]; requests: FigureRequest[]; review: FigureReview | null;
  error: string | null; createdAt: string; updatedAt: string;
}
export interface FigureView { projectId: string; run: FigureRun; active: boolean; activeCount?: number }
export interface FigureDocument { svg: string | null; rawOutput?: string | null; sourceDataUrl: string | null; previewDataUrl: string | null }
export interface FigureConnections {
  executor: ModelIdentity; reviewer: ModelIdentity;
  executorModels?: string[];
  image: { enabled: boolean; available: boolean; model: string | null; models: string[] };
}
export interface PrepareFigure {
  projectId: string; id: string; title: string; method: string; style: string;
  sourceMode: "import" | "generate"; sourceBase64: string | null; outputLimit: number; model: string | null;
}
