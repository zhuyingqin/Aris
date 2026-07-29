// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, DesktopCommandSpec, SkillMeta } from "../../types";
import { useStore } from "../../store";
import ChatComposer, { attachmentFromFile, resizeComposerTextarea } from "../ChatComposer";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ language: "en" });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatComposer textarea and attachments", () => {
  it("caps composer auto-growth and enables textarea scrolling", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 240 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ maxHeight: "100px" } as CSSStyleDeclaration);

    resizeComposerTextarea(textarea);

    expect(textarea.style.height).toBe("100px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("omits dropped binary bodies without reading them into the renderer", async () => {
    const file = new File(["binary"], "archive.zip", { type: "application/zip" });
    const text = vi.fn();
    Object.defineProperty(file, "text", { configurable: true, value: text });

    const attachment = await attachmentFromFile(file);

    expect(text).not.toHaveBeenCalled();
    expect(attachment.content).toContain("Binary file content omitted");
  });

  it("keeps a dragged Tauri PDF as a readable path attachment", async () => {
    const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "path", { configurable: true, value: "C:\\Project\\paper.pdf" });

    const attachment = await attachmentFromFile(file);

    expect(attachment.path).toBe("C:\\Project\\paper.pdf");
    expect(attachment.content).toBeUndefined();
    expect(attachment.name).toBe("paper.pdf");
  });

  it("keeps image previews out of the prompt body", async () => {
    const file = new File(["fake-png"], "shot.png", { type: "image/png" });

    const attachment = await attachmentFromFile(file);

    expect(attachment.kind).toBe("image");
    expect(attachment.preview).toMatch(/^data:image\/png;base64,/);
    expect(attachment.content).toContain("Vision input is not supported");
    expect(attachment.content).not.toMatch(/^data:/);
  });

  it("allows the context compaction notice to be dismissed", async () => {
    const user = userEvent.setup();
    const onContextStatusDismiss = vi.fn();
    render(
      <ChatComposer
        input=""
        commands={[]}
        skills={[]}
        attachments={[]}
        busy={false}
        ready
        editing={false}
        contextStatus={{
          kind: "compacted",
          message: "Context was compacted automatically.",
          detail: "Earlier messages were summarized.",
        }}
        onContextStatusDismiss={onContextStatusDismiss}
        onInputChange={() => undefined}
        onAttachmentsChange={() => undefined}
        onSubmit={() => undefined}
        onStop={() => undefined}
        onCancelEdit={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dismiss context notice" }));

    expect(onContextStatusDismiss).toHaveBeenCalledOnce();
  });

  it("selects a remote Agent target and disables local attachments", async () => {
    const user = userEvent.setup();
    const onAgentTargetChange = vi.fn();
    render(
      <ChatComposer
        input=""
        commands={[]}
        skills={[]}
        attachments={[]}
        busy={false}
        ready
        editing={false}
        attachmentsEnabled={false}
        agentTargetLabel="Local Agent"
        agentTargetValue="local"
        agentTargetOptions={[
          { value: "local", label: "Local Agent" },
          { value: "remote|node-a|project-a", label: "Lab computer / Project A" },
        ]}
        onAgentTargetChange={onAgentTargetChange}
        onInputChange={() => undefined}
        onAttachmentsChange={() => undefined}
        onSubmit={() => undefined}
        onStop={() => undefined}
        onCancelEdit={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Local Agent/ }));
    await user.click(screen.getByRole("menuitem", { name: /Lab computer/ }));

    expect(onAgentTargetChange).toHaveBeenCalledWith("remote|node-a|project-a");
    expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const SKILLS: SkillMeta[] = [
  { name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" },
  { name: "review", description: "Review code", path: "review/SKILL.md" },
];

function ComposerHarness({
  commands = [],
  skills = SKILLS,
  onSubmit = () => undefined,
}: {
  commands?: DesktopCommandSpec[];
  skills?: SkillMeta[];
  onSubmit?: () => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  return (
    <ChatComposer
      input={input}
      commands={commands}
      skills={skills}
      attachments={attachments}
      busy={false}
      ready
      editing={false}
      onInputChange={setInput}
      onAttachmentsChange={setAttachments}
      onSubmit={onSubmit}
      onStop={() => undefined}
      onCancelEdit={() => undefined}
      onHeightChange={() => undefined}
    />
  );
}

function RerenderComposerHarness() {
  const [renderCount, setRenderCount] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setRenderCount((count) => count + 1)}>
        Rerender {renderCount}
      </button>
      <ComposerHarness />
    </>
  );
}

describe("ChatComposer picker keyboard operation", () => {
  it("loads recent picker entries only once across unrelated renders", async () => {
    localStorage.setItem("somniq-chat-recent-skills", JSON.stringify(["paper-plan"]));
    localStorage.setItem("somniq-chat-recent-files", JSON.stringify(["src/chat/Chat.tsx"]));
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const user = userEvent.setup();
    render(<RerenderComposerHarness />);

    expect(getItem).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: /Rerender/ }));
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it("allows a second chat to submit while another chat is running", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(textbox, "draft for later");

    expect(textbox.disabled).toBe(false);
    expect(textbox.value).toBe("draft for later");
    const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("selects a fuzzy-matched slash skill with Enter", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/ppln");
    await user.keyboard("{Enter}");

    expect((textbox as HTMLTextAreaElement).value).toBe("/paper-plan ");
  });

  it("surfaces literature skills for /lit", async () => {
    const user = userEvent.setup();
    render(
      <ComposerHarness
        skills={[
          { name: "utility-cleanup", description: "General maintenance helpers", path: "utility-cleanup/SKILL.md" },
          { name: "research-lit", description: "Search and analyze research papers", path: "research-lit/SKILL.md" },
          { name: "comm-lit-review", description: "Communications-domain literature review", path: "comm-lit-review/SKILL.md" },
        ]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/lit");

    const picker = screen.getByRole("listbox");
    const names = within(picker).getAllByText(/^\/.+/).map((item) => item.textContent);
    expect(names.slice(0, 2)).toEqual(["/comm-lit-review", "/research-lit"]);
    expect(within(picker).getByText("/research-lit")).toBeTruthy();
  });

  it("submits an exact built-in slash command with Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ComposerHarness
        onSubmit={onSubmit}
        commands={[
          {
            name: "model",
            description: "Show or switch model",
          },
        ]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/model");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect((textbox as HTMLTextAreaElement).value).toBe("/model");
  });

  it("submits an unmatched slash command instead of trapping Enter in the picker", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} commands={[]} skills={[]} />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/some-custom-command");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("groups desktop commands separately from skills", async () => {
    const user = userEvent.setup();
    render(
      <ComposerHarness
        commands={[
          {
            name: "help",
            description: "Show commands",
          },
        ]}
        skills={[{ name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" }]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/");

    const picker = screen.getByRole("listbox");
    expect(within(picker).getByText("Slash menu")).toBeTruthy();
    expect(within(picker).getByText("System commands")).toBeTruthy();
    expect(within(picker).getByText("All skills")).toBeTruthy();
  });

  it("scrolls the active picker item into view when arrowing", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <ComposerHarness
        commands={[
          { name: "help", description: "Show commands" },
          { name: "model", description: "Switch model" },
        ]}
        skills={[{ name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" }]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/");
    scrollIntoView.mockClear();
    await user.keyboard("{ArrowDown}");

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("attaches a recent @ file with Enter instead of inserting its body", async () => {
    localStorage.setItem("somniq-chat-recent-files", JSON.stringify(["src/chat/Chat.tsx"]));
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "@Chat");
    await user.keyboard("{Enter}");

    expect((textbox as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Chat.tsx")).toBeTruthy();
  });

  it("attaches an uploaded image with a preview", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    const fileInput = screen.getByTestId("chat-file-input") as HTMLInputElement;
    const clickInput = vi.spyOn(fileInput, "click");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(clickInput).toHaveBeenCalledOnce();

    const file = new File(["fake-png"], "shot.png", { type: "image/png" });
    await user.upload(fileInput, file);

    expect(await screen.findByText("shot.png")).toBeTruthy();
    const preview = await screen.findByRole("img", { name: "shot.png" });
    expect((preview as HTMLImageElement).src).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  });
});
