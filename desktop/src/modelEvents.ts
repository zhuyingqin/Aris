const CHAT_MODELS_UPDATED_EVENT = "somniq-chat-models-updated";

interface ChatModelsUpdatedOptions { refreshPricing?: boolean }

export function notifyChatModelsUpdated(options: ChatModelsUpdatedOptions = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_MODELS_UPDATED_EVENT, { detail: options }));
}

export function onChatModelsUpdated(handler: (options: ChatModelsUpdatedOptions) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => handler((event as CustomEvent<ChatModelsUpdatedOptions>).detail ?? {});
  window.addEventListener(CHAT_MODELS_UPDATED_EVENT, listener);
  return () => window.removeEventListener(CHAT_MODELS_UPDATED_EVENT, listener);
}
