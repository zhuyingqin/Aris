import { create } from "zustand";
import {
  isTauri,
  literatureDownloadPdf,
  literatureLoad,
  literatureSave,
  literatureSearch,
  onChatDone,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import {
  emptyLibrary,
  type ActivityEntry,
  type ActivityLevel,
  type LiteratureLibrary,
  type LiteraturePaper,
  type LiteratureSearchResult,
  type PaperStage,
  type PdfDownloadResult,
  type RemotePaper,
} from "./literatureTypes";

const MAX_ACTIVITY_ENTRIES = 200;

const PERSIST_DELAY_MS = 600;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const isoNow = () => new Date().toISOString();

const normalizedTitle = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]/g, "");

const sameRecord = (paper: LiteraturePaper, remote: RemotePaper) =>
  paper.id === remote.id ||
  (Boolean(paper.doi) && paper.doi === (remote.doi ?? undefined)) ||
  (Boolean(paper.arxivId) && paper.arxivId === (remote.arxivId ?? undefined)) ||
  normalizedTitle(paper.title) === normalizedTitle(remote.title);

const paperFromRemote = (remote: RemotePaper, searchId: string): LiteraturePaper => ({
  id: remote.id,
  title: remote.title,
  authors: remote.authors,
  year: remote.year ?? undefined,
  venue: remote.venue,
  doi: remote.doi ?? undefined,
  arxivId: remote.arxivId ?? undefined,
  url: remote.url ?? undefined,
  abstract: remote.abstract,
  tags: [],
  collectionIds: [],
  searchIds: [searchId],
  stage: "inbox",
  starred: false,
  unread: true,
  source: remote.source,
  citedBy: remote.citedBy ?? undefined,
  addedAt: isoNow(),
  pdf: { status: "none", url: remote.pdfUrl ?? undefined },
  evidence: [],
});

/** Fill gaps from a re-discovered record without touching user state. */
const enrichFromRemote = (
  paper: LiteraturePaper,
  remote: RemotePaper,
  searchId: string,
): LiteraturePaper => ({
  ...paper,
  doi: paper.doi ?? remote.doi ?? undefined,
  arxivId: paper.arxivId ?? remote.arxivId ?? undefined,
  url: paper.url ?? remote.url ?? undefined,
  year: paper.year ?? remote.year ?? undefined,
  venue: paper.venue || remote.venue,
  abstract: paper.abstract || remote.abstract,
  citedBy: remote.citedBy ?? paper.citedBy,
  pdf: { ...paper.pdf, url: paper.pdf.url ?? remote.pdfUrl ?? undefined },
  searchIds: paper.searchIds.includes(searchId)
    ? paper.searchIds
    : [...paper.searchIds, searchId],
});

const pdfFileName = (paper: LiteraturePaper) => {
  if (paper.arxivId) return `${paper.arxivId.replace(/\//g, "-")}.pdf`;
  if (paper.doi) return `${paper.doi.replace(/[/\\:]/g, "-")}.pdf`;
  return `${normalizedTitle(paper.title).slice(0, 60) || "paper"}.pdf`;
};

const PREVIEW_LIBRARY: LiteratureLibrary = {
  version: 1,
  papers: [
    {
      id: "arxiv:2602.01491",
      title: "Agentic Literature Review: Planning, Retrieval, and Grounded Synthesis",
      authors: ["M. Rivera", "L. Chen", "A. Novak"],
      year: 2026,
      venue: "arXiv",
      doi: "10.48550/arxiv.2602.01491",
      arxivId: "2602.01491",
      url: "https://arxiv.org/abs/2602.01491",
      abstract:
        "A system design for decomposing literature review work into retrieval, screening, reading, and evidence-grounded writing steps.",
      tags: ["agent", "review"],
      collectionIds: [],
      searchIds: [],
      stage: "downloaded",
      starred: true,
      unread: false,
      source: "arXiv",
      addedAt: "2026-06-09T08:00:00.000Z",
      pdf: {
        status: "downloaded",
        url: "https://arxiv.org/pdf/2602.01491.pdf",
        path: "papers/2602.01491.pdf",
      },
      verdict: {
        fit: "high",
        score: 92,
        rationale:
          "Separates metadata triage from full-text reading and keeps every summary anchored to cited evidence spans.",
        decidedAt: "2026-06-09T08:10:00.000Z",
      },
      evidence: [
        {
          id: "ev-1",
          page: 3,
          quote: "Screening decisions are recorded before full-text extraction.",
          note: "Supports the staged UI: metadata first, PDF later.",
        },
      ],
    },
    {
      id: "doi:10.1145/example.1024",
      title: "Grounded PDF Summarization with Human-in-the-loop Annotation",
      authors: ["S. Iyer", "P. Almeida"],
      year: 2025,
      venue: "CHI Late Breaking Work",
      doi: "10.1145/example.1024",
      url: "https://doi.org/10.1145/example.1024",
      abstract:
        "An interface study on combining automatic PDF summarization with reader annotations and editable evidence snippets.",
      tags: ["pdf", "ux"],
      collectionIds: [],
      searchIds: [],
      stage: "screened",
      starred: false,
      unread: true,
      source: "Crossref",
      citedBy: 12,
      addedAt: "2026-06-08T15:00:00.000Z",
      pdf: { status: "none" },
      verdict: {
        fit: "medium",
        score: 74,
        rationale: "Strong on annotation UX, but does not cover autonomous screening.",
        decidedAt: "2026-06-08T15:20:00.000Z",
      },
      evidence: [],
    },
    {
      id: "arxiv:2409.01010",
      title: "General Web Agents for Form Filling",
      authors: ["D. Lewis", "H. Kim"],
      year: 2024,
      venue: "arXiv",
      arxivId: "2409.01010",
      url: "https://arxiv.org/abs/2409.01010",
      abstract: "A broad web automation benchmark focused on browser control and form completion.",
      tags: ["web"],
      collectionIds: [],
      searchIds: [],
      stage: "inbox",
      starred: false,
      unread: true,
      source: "arXiv",
      addedAt: "2026-06-07T11:00:00.000Z",
      pdf: { status: "none", url: "https://arxiv.org/pdf/2409.01010.pdf" },
      evidence: [],
    },
  ],
  searches: [
    {
      id: "search-preview",
      query: "agentic literature review",
      sources: ["arxiv", "crossref"],
      ranAt: "2026-06-09T08:00:00.000Z",
      resultCount: 18,
      newCount: 3,
    },
  ],
  collections: [{ id: "col-core", label: "Core review" }],
};

interface LiteratureState {
  library: LiteratureLibrary;
  loaded: boolean;
  loadedProjectId: string | null;
  searching: boolean;
  lastSearch: {
    searchId: string;
    resultCount: number;
    newCount: number;
    warnings: string[];
  } | null;
  error: string | null;
  /** Terminal-style log narrating every library write and agent action. */
  activity: ActivityEntry[];
  activityOpen: boolean;

  setActivityOpen: (open: boolean) => void;
  clearActivity: () => void;
  load: (projectId: string, options?: { quiet?: boolean }) => Promise<void>;
  /** Reload the library when a chat turn ends — literature skills may have
   * upserted papers through the kernel tools. Returns a teardown fn. */
  watchAgentActivity: () => () => void;
  runSearch: (query: string, sources: string[]) => Promise<void>;
  setStage: (ids: string[], stage: PaperStage) => void;
  toggleStar: (id: string) => void;
  markRead: (id: string) => void;
  addTags: (ids: string[], tags: string[]) => void;
  addCollection: (label: string) => void;
  assignCollection: (ids: string[], collectionId: string) => void;
  downloadPdf: (id: string) => Promise<void>;
  setError: (message: string | null) => void;
}

export const useLiteratureStore = create<LiteratureState>((set, get) => {
  const log = (level: ActivityLevel, text: string, options?: { open?: boolean }) => {
    const entry: ActivityEntry = {
      id: makeId("act"),
      at: isoNow(),
      level,
      text,
    };
    set((state) => ({
      activity: [...state.activity, entry].slice(-MAX_ACTIVITY_ENTRIES),
      activityOpen: options?.open ? true : state.activityOpen,
    }));
  };

  const persist = () => {
    if (!isTauri()) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      literatureSave(get().library).catch((error) =>
        set({ error: `failed to save library: ${String(error)}` }),
      );
    }, PERSIST_DELAY_MS);
  };

  const mutate = (update: (library: LiteratureLibrary) => LiteratureLibrary) => {
    set({ library: update(get().library) });
    persist();
  };

  const patchPapers = (ids: string[], patch: (paper: LiteraturePaper) => LiteraturePaper) =>
    mutate((library) => ({
      ...library,
      papers: library.papers.map((paper) =>
        ids.includes(paper.id) ? patch(paper) : paper,
      ),
    }));

  return {
    library: emptyLibrary(),
    loaded: false,
    loadedProjectId: null,
    searching: false,
    lastSearch: null,
    error: null,
    activity: [],
    activityOpen: false,

    setActivityOpen: (open) => set({ activityOpen: open }),
    clearActivity: () => set({ activity: [] }),

    load: async (projectId, options) => {
      // Drop any pending save: the backend already points at the new project,
      // so flushing now would write the old project's library into it.
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (!isTauri()) {
        set({ library: PREVIEW_LIBRARY, loaded: true, loadedProjectId: projectId });
        return;
      }
      try {
        const raw = await literatureLoad<Partial<LiteratureLibrary>>();
        set({
          library: {
            version: 1,
            papers: raw.papers ?? [],
            searches: raw.searches ?? [],
            collections: raw.collections ?? [],
          },
          loaded: true,
          loadedProjectId: projectId,
        });
        if (!options?.quiet) {
          log("info", `Loaded ${raw.papers?.length ?? 0} papers from papers/library.json`);
        }
      } catch (error) {
        set({ error: `failed to load library: ${String(error)}` });
        log("error", `✗ Failed to load library: ${String(error)}`, { open: true });
      }
    },

    watchAgentActivity: () => {
      if (!isTauri()) return () => {};
      let disposed = false;
      const teardowns: Array<() => void> = [];
      // Set when a Literature* tool ran during the current chat turn, so the
      // chat-done reload can say why the library changed.
      let agentTouchedLibrary = false;

      const register = (subscription: Promise<() => void>) => {
        void subscription.then((teardown) => {
          if (disposed) teardown();
          else teardowns.push(teardown);
        });
      };

      register(
        onChatTool((tool) => {
          if (disposed || !tool.name.startsWith("Literature")) return;
          agentTouchedLibrary = true;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tool.input) as Record<string, unknown>;
          } catch {
            // tool input is informational only
          }
          if (tool.name === "LiteratureSearch") {
            log("info", `→ Agent (Chat): searching "${String(input.query ?? "…")}"`, {
              open: true,
            });
          } else if (tool.name === "LiteratureLibraryUpsert") {
            const count = Array.isArray(input.papers) ? input.papers.length : "?";
            log("info", `→ Agent (Chat): saving ${count} records to the library…`, {
              open: true,
            });
          } else if (tool.name === "LiteraturePdfDownload") {
            log("info", `→ Agent (Chat): downloading PDF ${String(input.fileName ?? "")}`, {
              open: true,
            });
          }
        }),
      );

      register(
        onChatToolResult((result) => {
          if (disposed || !result.name.startsWith("Literature")) return;
          if (result.isError) {
            log("warn", `! Agent ${result.name} failed: ${result.output.slice(0, 160)}`);
            return;
          }
          let output: Record<string, unknown> = {};
          try {
            output = JSON.parse(result.output) as Record<string, unknown>;
          } catch {
            return;
          }
          if (result.name === "LiteratureLibraryUpsert") {
            log(
              "ok",
              `✓ Agent saved ${Number(output.added ?? 0)} new / ${Number(output.merged ?? 0)} merged → papers/library.json`,
            );
          } else if (result.name === "LiteraturePdfDownload") {
            log("ok", `✓ Agent downloaded ${String(output.relativePath ?? "PDF")}`);
          }
        }),
      );

      register(
        onChatDone(() => {
          if (disposed) return;
          const touched = agentTouchedLibrary;
          agentTouchedLibrary = false;
          // A pending UI save means fresh local edits; let them win this round.
          if (persistTimer) return;
          const projectId = get().loadedProjectId;
          if (!projectId) return;
          const before = get().library.papers.length;
          set({ loaded: false });
          void get()
            .load(projectId, { quiet: true })
            .then(() => {
              if (!touched) return;
              const delta = get().library.papers.length - before;
              log(
                delta > 0 ? "ok" : "info",
                delta > 0
                  ? `✓ Library reloaded after chat turn: +${delta} ${delta === 1 ? "paper" : "papers"}`
                  : "Library reloaded after chat turn (no new papers)",
              );
            });
        }),
      );

      return () => {
        disposed = true;
        for (const teardown of teardowns) teardown();
      };
    },

    runSearch: async (query, sources) => {
      const trimmed = query.trim();
      if (!trimmed || get().searching) return;
      if (!isTauri()) {
        set({
          error:
            "remote search needs the desktop backend — run `npm run tauri dev` (browser preview shows sample data only)",
        });
        return;
      }
      set({ searching: true, error: null });
      log("info", `→ Searching arXiv + Crossref for "${trimmed}"`, { open: true });
      try {
        const result = await literatureSearch<LiteratureSearchResult>(trimmed, sources);
        for (const entry of result.sourceCounts ?? []) {
          log("info", `· ${entry.source} returned ${entry.count} records`);
        }
        for (const warning of result.warnings) {
          log("warn", `! ${warning}`);
        }
        const searchId = makeId("search");
        let newCount = 0;
        mutate((library) => {
          const papers = [...library.papers];
          for (const remote of result.papers) {
            const index = papers.findIndex((paper) => sameRecord(paper, remote));
            if (index >= 0) {
              papers[index] = enrichFromRemote(papers[index], remote, searchId);
            } else {
              papers.unshift(paperFromRemote(remote, searchId));
              newCount += 1;
            }
          }
          return {
            ...library,
            papers,
            searches: [
              {
                id: searchId,
                query: trimmed,
                sources,
                ranAt: isoNow(),
                resultCount: result.papers.length,
                newCount,
              },
              ...library.searches,
            ],
          };
        });
        set({
          lastSearch: {
            searchId,
            resultCount: result.papers.length,
            newCount,
            warnings: result.warnings,
          },
        });
        const merged = result.papers.length - newCount;
        log(
          "ok",
          `✓ ${newCount} new saved to Inbox · ${merged} already in library (metadata refreshed) → papers/library.json`,
        );
      } catch (error) {
        set({ error: `search failed: ${String(error)}` });
        log("error", `✗ Search failed: ${String(error)}`, { open: true });
      } finally {
        set({ searching: false });
      }
    },

    setStage: (ids, stage) => patchPapers(ids, (paper) => ({ ...paper, stage })),

    toggleStar: (id) =>
      patchPapers([id], (paper) => ({ ...paper, starred: !paper.starred })),

    markRead: (id) =>
      patchPapers([id], (paper) => (paper.unread ? { ...paper, unread: false } : paper)),

    addTags: (ids, tags) =>
      patchPapers(ids, (paper) => ({
        ...paper,
        tags: Array.from(new Set([...paper.tags, ...tags])).sort(),
      })),

    addCollection: (label) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      mutate((library) => ({
        ...library,
        collections: [...library.collections, { id: makeId("col"), label: trimmed }],
      }));
    },

    assignCollection: (ids, collectionId) =>
      patchPapers(ids, (paper) => ({
        ...paper,
        collectionIds: paper.collectionIds.includes(collectionId)
          ? paper.collectionIds
          : [...paper.collectionIds, collectionId],
      })),

    downloadPdf: async (id) => {
      const paper = get().library.papers.find((entry) => entry.id === id);
      const url = paper?.pdf.url;
      if (!paper || !url) {
        set({ error: "no direct PDF link is known for this paper" });
        return;
      }
      if (!isTauri()) {
        set({
          error:
            "PDF download needs the desktop backend — run `npm run tauri dev` (browser preview shows sample data only)",
        });
        return;
      }
      if (paper.pdf.status === "downloading") return;
      patchPapers([id], (entry) => ({
        ...entry,
        pdf: { ...entry.pdf, status: "downloading", error: undefined },
      }));
      log("info", `→ Downloading PDF: ${pdfFileName(paper)}`, { open: true });
      try {
        const saved = await literatureDownloadPdf<PdfDownloadResult>(url, pdfFileName(paper));
        patchPapers([id], (entry) => ({
          ...entry,
          stage:
            entry.stage === "inbox" || entry.stage === "screened" || entry.stage === "shortlist"
              ? "downloaded"
              : entry.stage,
          pdf: {
            ...entry.pdf,
            status: "downloaded",
            path: saved.relativePath,
            bytes: saved.bytes,
          },
        }));
        log("ok", `✓ PDF saved → ${saved.relativePath} (${Math.max(1, Math.round(saved.bytes / 1024))} KB)`);
      } catch (error) {
        patchPapers([id], (entry) => ({
          ...entry,
          pdf: { ...entry.pdf, status: "failed", error: String(error) },
        }));
        set({ error: `PDF download failed: ${String(error)}` });
        log("error", `✗ PDF download failed: ${String(error)}`, { open: true });
      }
    },

    setError: (message) => set({ error: message }),
  };
});

/** Test helper: reset the singleton store between cases. */
export const resetLiteratureStore = () =>
  useLiteratureStore.setState({
    library: emptyLibrary(),
    loaded: false,
    loadedProjectId: null,
    searching: false,
    lastSearch: null,
    error: null,
    activity: [],
    activityOpen: false,
  });
