const CHAT_MODELS_UPDATED_EVENT = "somniq-chat-models-updated";

export function notifyChatModelsUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHAT_MODELS_UPDATED_EVENT));
}

export function onChatModelsUpdated(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHAT_MODELS_UPDATED_EVENT, handler);
  return () => window.removeEventListener(CHAT_MODELS_UPDATED_EVENT, handler);
}
