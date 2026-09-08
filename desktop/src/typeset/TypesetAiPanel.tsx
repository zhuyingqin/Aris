import Chat from "../chat/Chat";
import { useStore } from "../store";

/**
 * Typeset's assistant is the same Chat surface used by the writing companion.
 * Keeping this component as a thin host is intentional: sessions, streaming,
 * tools, model/reasoning controls, permissions, and history all stay on the
 * shared Chat runtime instead of diverging into a second mock implementation.
 */
export interface TypesetAiPanelProps {
  /** Keep the Chat instance mounted while another Typeset rail panel is visible. */
  visible?: boolean;
  prepareEditorContext?: import("../chat/Chat").ChatProps["prepareEditorContext"];
}

export default function TypesetAiPanel({ visible = true, prepareEditorContext }: TypesetAiPanelProps = {}) {
  const tab = useStore((state) => state.tab);

  if (tab !== "typeset") {
    return null;
  }

  return (
    <div
      className="typeset-ai-panel typeset-ai-chat-host"
      role="region"
      aria-label="AI assistant"
      aria-hidden={visible ? undefined : true}
      hidden={!visible}
      style={visible ? undefined : { display: "none" }}
    >
      <Chat embedded prepareEditorContext={prepareEditorContext} />
    </div>
  );
}
