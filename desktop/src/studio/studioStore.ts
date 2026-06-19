import { create } from "zustand";
import {
  fileOpen,
  isTauri,
  studioLoad,
  studioSave,
} from "../api/tauri";
import { useStore } from "../store";
import {
  emptyStudioLibrary,
  type StudioArtifact,
  type StudioArtifactKind,
  type StudioLibrary,
  type StudioPageReview,
} from "./studioTypes";

const PERSIST_DELAY_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const isoNow = () => new Date().toISOString();
const makeReviewId = () =>
  `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeReview = (
  review: Partial<StudioPageReview>,
  index: number,
): StudioPageReview => {
  const createdAt = review.createdAt || isoNow();
  const status = review.status === "submitted" || review.status === "resolved"
    ? review.status
    : "open";
  return {
    id: review.id?.trim() || `review-${index}`,
    page: Math.max(1, Math.floor(review.page ?? 1)),
    body: review.body?.trim() || "",
    status,
    createdAt,
    updatedAt: review.updatedAt || createdAt,
  };
};

const normalizeArtifact = (
  artifact: Partial<StudioArtifact>,
  index: number,
): StudioArtifact => {
  const kind: StudioArtifactKind =
    artifact.kind === "poster" || artifact.kind === "web" ? artifact.kind : "slides";
  return {
    ...artifact,
    id: artifact.id?.trim() || `${kind}:${index}`,
    kind,
    title: artifact.title?.trim() || (kind === "poster" ? "Poster" : kind === "web" ? "Web" : "Slides"),
    status: artifact.status ?? "ready",
    generatedAt: artifact.generatedAt || isoNow(),
    pinned: artifact.pinned === true,
    notes: artifact.notes ?? "",
    pageReviews: Array.isArray(artifact.pageReviews)
      ? artifact.pageReviews.map(normalizeReview).filter((review) => review.body)
      : [],
  };
};

const normalizeLibrary = (library: Partial<StudioLibrary>): StudioLibrary => ({
  version: 1,
  artifacts: Array.isArray(library.artifacts)
    ? library.artifacts.map(normalizeArtifact)
    : [],
});

/** Static fixture for the plain-browser preview (no Tauri backend), mirroring
 * the Literature library's PREVIEW_LIBRARY. The PDF itself only renders under
 * the desktop backend, but the result list, page-review panel, and overview
 * are fully exercised so the tab is demoable and visually reviewable. */
const PREVIEW_STUDIO_LIBRARY: StudioLibrary = {
  version: 1,
  artifacts: [
    {
      id: "slides:main",
      kind: "slides",
      title: "Grounded Literature Review — NeurIPS talk",
      status: "ready",
      texPath: "slides/main.tex",
      pdfPath: "slides/main.pdf",
      pptxPath: "slides/main.pptx",
      speakerNotesPath: "slides/SPEAKER_NOTES.md",
      venue: "NeurIPS",
      generatedAt: "2026-06-14T09:30:00.000Z",
      pinned: true,
      notes: "Keep the 60-second story arc. Reviewer flagged the results slide as too dense.",
      pageReviews: [
        {
          id: "review-1",
          page: 1,
          body: "Title slide: drop the subtitle, it repeats the title. Make author affiliation one line.",
          status: "open",
          createdAt: "2026-06-14T10:00:00.000Z",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
        {
          id: "review-2",
          page: 4,
          body: "Results table has 7 columns — too dense for a talk. Keep the 3 headline numbers, move the rest to backup.",
          status: "open",
          createdAt: "2026-06-14T10:02:00.000Z",
          updatedAt: "2026-06-14T10:02:00.000Z",
        },
        {
          id: "review-3",
          page: 2,
          body: "Method figure is good. Bump the font on the box labels.",
          status: "resolved",
          createdAt: "2026-06-14T10:05:00.000Z",
          updatedAt: "2026-06-14T11:00:00.000Z",
        },
      ],
    },
    {
      id: "poster:main",
      kind: "poster",
      title: "Agentic Review Pipeline — A0 poster",
      status: "ready",
      texPath: "poster/main.tex",
      pdfPath: "poster/main.pdf",
      svgPath: "poster/main.svg",
      venue: "ICML",
      size: "A0",
      orientation: "landscape",
      generatedAt: "2026-06-13T16:00:00.000Z",
      pinned: false,
      notes: "",
      pageReviews: [
        {
          id: "review-4",
          page: 1,
          body: "Column 3 (Results) is visually lighter than the rest — add the bar chart to balance the weight.",
          status: "open",
          createdAt: "2026-06-13T16:20:00.000Z",
          updatedAt: "2026-06-13T16:20:00.000Z",
        },
      ],
    },
    {
      id: "web:interactive-demo",
      kind: "web",
      title: "Interactive Research Demo",
      status: "ready",
      htmlPath: "web/interactive-demo.html",
      generatedAt: "2026-06-15T08:22:30.000Z",
      pinned: false,
      notes: "Interactive HTML previews run inside an isolated Studio frame.",
      pageReviews: [],
    },
  ],
};

const revisionPrompt = (artifact: StudioArtifact, reviews: StudioPageReview[]) => {
  const paths = [
    artifact.pptxPath,
    artifact.texPath,
    artifact.pdfPath,
    artifact.svgPath,
    artifact.htmlPath,
  ].filter((path): path is string => Boolean(path));
  return [
    "Revise an existing Studio artifact from the user's page-specific review feedback.",
    "Do not generate a new deck or poster from the paper. Work from the existing artifact and make only the requested changes.",
    `Artifact id: ${artifact.id}`,
    `Kind: ${artifact.kind}`,
    `Title: ${artifact.title}`,
    `Existing files: ${paths.join(", ") || "none indexed"}`,
    "",
    "Page feedback:",
    ...reviews.map((review) => `[Page ${review.page}] ${review.body}`),
    "",
    "Render or export an updated viewable result only as required by the artifact's existing workflow.",
    "Before finishing, call StudioLibraryUpsert with the updated result paths and metadata. Do not overwrite title, pinned state, notes, or pageReviews.",
  ].join("\n");
};

interface StudioState {
  library: StudioLibrary;
  loaded: boolean;
  loadedProjectId: string | null;
  error: string | null;

  load: (projectId: string) => Promise<void>;
  updateArtifact: (id: string, patch: Partial<StudioArtifact>) => void;
  addPageReview: (id: string, page: number, body: string) => void;
  updatePageReview: (
    id: string,
    reviewId: string,
    patch: Partial<Pick<StudioPageReview, "body" | "status">>,
  ) => void;
  deletePageReview: (id: string, reviewId: string) => void;
  requestRevision: (id: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  setError: (error: string | null) => void;
}

export const useStudioStore = create<StudioState>((set, get) => {
  const persist = () => {
    if (!isTauri()) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      studioSave(get().library).catch((error) =>
        set({ error: `failed to save Studio library: ${String(error)}` }),
      );
    }, PERSIST_DELAY_MS);
  };

  const patchArtifact = (id: string, patch: Partial<StudioArtifact>) => {
    set((state) => ({
      library: {
        ...state.library,
        artifacts: state.library.artifacts.map((artifact) =>
          artifact.id === id ? { ...artifact, ...patch } : artifact,
        ),
      },
    }));
    persist();
  };

  return {
    library: emptyStudioLibrary(),
    loaded: false,
    loadedProjectId: null,
    error: null,

    load: async (projectId) => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (!isTauri()) {
        set({ library: PREVIEW_STUDIO_LIBRARY, loaded: true, loadedProjectId: projectId });
        return;
      }
      set({ error: null });
      try {
        const library = normalizeLibrary(await studioLoad<Partial<StudioLibrary>>());
        set({ library, loaded: true, loadedProjectId: projectId });
      } catch (error) {
        set({ error: `failed to load Studio library: ${String(error)}` });
      }
    },

    updateArtifact: patchArtifact,

    addPageReview: (id, page, body) => {
      const artifact = get().library.artifacts.find((entry) => entry.id === id);
      const trimmed = body.trim();
      if (!artifact || !trimmed) return;
      const now = isoNow();
      patchArtifact(id, {
        pageReviews: [
          ...artifact.pageReviews,
          {
            id: makeReviewId(),
            page: Math.max(1, Math.floor(page)),
            body: trimmed,
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
    },

    updatePageReview: (id, reviewId, patch) => {
      const artifact = get().library.artifacts.find((entry) => entry.id === id);
      if (!artifact) return;
      patchArtifact(id, {
        pageReviews: artifact.pageReviews.map((review) =>
          review.id === reviewId
            ? {
                ...review,
                ...patch,
                body: patch.body === undefined ? review.body : patch.body.trim(),
                updatedAt: isoNow(),
              }
            : review,
        ),
      });
    },

    deletePageReview: (id, reviewId) => {
      const artifact = get().library.artifacts.find((entry) => entry.id === id);
      if (!artifact) return;
      patchArtifact(id, {
        pageReviews: artifact.pageReviews.filter((review) => review.id !== reviewId),
      });
    },

    requestRevision: async (id) => {
      const artifact = get().library.artifacts.find((entry) => entry.id === id);
      const openReviews = artifact?.pageReviews.filter((review) => review.status === "open") ?? [];
      if (!artifact || openReviews.length === 0) return;

      // Mark open reviews as submitted immediately (optimistic)
      patchArtifact(id, {
        pageReviews: artifact.pageReviews.map((review) =>
          openReviews.some((r) => r.id === review.id)
            ? { ...review, status: "submitted" as const, updatedAt: isoNow() }
            : review,
        ),
      });

      // Route the revision prompt to Chat so the user can see and interact with it
      const mainStore = useStore.getState();
      mainStore.setPendingChatRunInput(revisionPrompt(artifact, openReviews));
      mainStore.setTab("chat");
    },

    openPath: async (path) => {
      if (!isTauri()) return;
      try {
        await fileOpen(path);
      } catch (error) {
        set({ error: `failed to open ${path}: ${String(error)}` });
      }
    },

    setError: (error) => set({ error }),
  };
});

export const resetStudioStore = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  useStudioStore.setState({
    library: emptyStudioLibrary(),
    loaded: false,
    loadedProjectId: null,
    error: null,
  });
};
