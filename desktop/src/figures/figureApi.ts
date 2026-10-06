import { hasNativeBackend, invoke, listen } from "../api/transport";
import type { FigureConnections, FigureDocument, FigureView, PrepareFigure } from "./types";

export const figuresAvailable = hasNativeBackend;
export const figuresRunningCount = () => invoke<number>("figures_running_count");
export const figureConnections = (model: string | null = null) => invoke<FigureConnections>("figures_connections", { model });
export const figureList = (projectId: string) => invoke<FigureView[]>("figures_list", { projectId });
export const figurePrepare = (input: PrepareFigure) => invoke<FigureView>("figures_prepare", { input });
export const figureStart = (projectId: string, id: string) => invoke<FigureView>("figures_start", { projectId, id });
export const figureCancel = (projectId: string, id: string) => invoke<void>("figures_cancel", { projectId, id });
export const figureReview = (projectId: string, id: string) => invoke<FigureView>("figures_review", { projectId, id });
export const figureDocument = (projectId: string, id: string, versionIndex: number | null = null) => invoke<FigureDocument>("figures_document", { projectId, id, versionIndex });
export const figureSave = (projectId: string, id: string, expectedHash: string | null, svg: string) => invoke<FigureView>("figures_save", { projectId, id, expectedHash, svg });
export const figureExport = (projectId: string, id: string, format: string, destination: string | null, versionIndex: number | null = null) => invoke<{ filename: string; mimeType: string; dataBase64: string }>("figures_export", { projectId, id, format, destination, versionIndex });
export const onFigureUpdated = (handler: (view: FigureView) => void) => listen("figures-updated", (event) => handler(event.payload as FigureView));
