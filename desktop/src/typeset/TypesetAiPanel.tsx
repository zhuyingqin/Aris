import Chat from "../chat/Chat";

/**
 * Typeset's assistant is the same Chat surface used by the writing companion.
 * Keeping this component as a thin host is intentional: sessions, streaming,
 * tools, model/reasoning controls, permissions, and history all stay on the
 * shared Chat runtime instead of diverging into a second mock implementation.
 */
export default function TypesetAiPanel() {
  return (
    <div
      className="typeset-ai-panel typeset-ai-chat-host"
      role="region"
      aria-label="AI assistant"
    >
      <Chat />
    </div>
  );
}
