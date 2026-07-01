import { create } from "zustand";

const STORAGE_KEY = "somniq-providers-v1";
const LEGACY_STORAGE_KEY = "aris-providers-v1";

function loadSaved(): Partial<State> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<State>) : {};
  } catch {
    return {};
  }
}

function makeId() {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ProviderEntry {
  id: string;
  name: string;
  url: string;
  notes: string;
  authJson: string;
  configToml: string;
  order: number;
}

interface State {
  providers: ProviderEntry[];
  executorProviderId: string | null;
  executorModel: string;
  reviewerProviderId: string | null;
  reviewerModel: string;
  add: (e: Omit<ProviderEntry, "id" | "order">) => string;
  update: (id: string, patch: Partial<Omit<ProviderEntry, "id">>) => void;
  remove: (id: string) => void;
  setExecutor: (providerId: string | null, model: string) => void;
  setReviewer: (providerId: string | null, model: string) => void;
}

const saved = loadSaved();

export const useProvidersStore = create<State>((set, get) => {
  const persist = () => {
    const { providers, executorProviderId, executorModel, reviewerProviderId, reviewerModel } = get();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ providers, executorProviderId, executorModel, reviewerProviderId, reviewerModel }),
      );
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch { /* quota errors */ }
  };

  return {
    providers: saved.providers ?? [],
    executorProviderId: saved.executorProviderId ?? null,
    executorModel: saved.executorModel ?? "",
    reviewerProviderId: saved.reviewerProviderId ?? null,
    reviewerModel: saved.reviewerModel ?? "",

    add: (entry) => {
      const id = makeId();
      const order = get().providers.length;
      set((s) => ({ providers: [...s.providers, { ...entry, id, order }] }));
      persist();
      return id;
    },

    update: (id, patch) => {
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
      persist();
    },

    remove: (id) => {
      set((s) => ({
        providers: s.providers.filter((p) => p.id !== id),
        executorProviderId: s.executorProviderId === id ? null : s.executorProviderId,
        reviewerProviderId: s.reviewerProviderId === id ? null : s.reviewerProviderId,
      }));
      persist();
    },

    setExecutor: (providerId, model) => { set({ executorProviderId: providerId, executorModel: model }); persist(); },
    setReviewer: (providerId, model) => { set({ reviewerProviderId: providerId, reviewerModel: model }); persist(); },
  };
});
