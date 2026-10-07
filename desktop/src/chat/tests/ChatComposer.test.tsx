// @vitest-environment jsdom

import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, DesktopCommandSpec, SkillMeta } from "../../types";
import { useStore } from "../../store";
import ChatComposer, { attachmentFromFile, attachmentFromPath, resizeComposerTextarea } from "../ChatComposer";

const attachmentApiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  chatImportAttachment: vi.fn(),
  chatImportAttachmentData: vi.fn(),
}));

vi.mock("../../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tauri")>()),
  ...attachmentApiMocks,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ language: "en" });
  attachmentApiMocks.isTauri.mockReturnValue(false);
  attachmentApiMocks.chatImportAttachment.mockReset();
  attachmentApiMocks.chatImportAttachmentData.mockReset();
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

  it("persists a pathless PDF before adding it to a native chat", async () => {
    attachmentApiMocks.isTauri.mockReturnValue(true);
    attachmentApiMocks.chatImportAttachmentData.mockResolvedValue({
      path: ".somniq/uploads/123-third-paper.pdf",
      name: "third-paper.pdf",
      bytes: 8,
    });
    const file = new File(["%PDF-1.4"], "third-paper.pdf", { type: "application/pdf" });

    const attachment = await attachmentFromFile(file);

    expect(attachmentApiMocks.chatImportAttachmentData).toHaveBeenCalledOnce();
    const [name, bytes] = attachmentApiMocks.chatImportAttachmentData.mock.calls[0];
    expect(name).toBe("third-paper.pdf");
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(new TextEncoder().encode("%PDF-1.4")));
    expect(attachment).toMatchObject({
      kind: "file",
      name: "third-paper.pdf",
      path: ".somniq/uploads/123-third-paper.pdf",
      mimeType: "application/pdf",
    });
    expect(attachment.content).toBeUndefined();
  });

  it("shows an upload error and does not create a fake attachment", async () => {
    attachmentApiMocks.isTauri.mockReturnValue(true);
    attachmentApiMocks.chatImportAttachmentData.mockRejectedValue(new Error("disk is full"));
    const user = userEvent.setup();
    render(<ComposerHarness />);

    await user.upload(
      screen.getByTestId("chat-file-input"),
      new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("paper.pdf: disk is full");
    expect(document.querySelector(".chat-attachment")).toBeNull();
  });

  it("keeps browser image previews as direct vision input without a stale fallback", async () => {
    const file = new File(["fake-png"], "shot.png", { type: "image/png" });

    const attachment = await attachmentFromFile(file);

    expect(attachment.kind).toBe("image");
    expect(attachment.preview).toMatch(/^data:image\/png;base64,/);
    expect(attachment.content).toBeUndefined();
  });

  it("persists a pathless image in native chat so tools receive its exact path", async () => {
    attachmentApiMocks.isTauri.mockReturnValue(true);
    attachmentApiMocks.chatImportAttachmentData.mockResolvedValue({
      path: ".somniq/uploads/456-shot.png",
      name: "shot.png",
      bytes: 8,
    });
    const file = new File(["fake-png"], "shot.png", { type: "image/png" });

    const attachment = await attachmentFromFile(file);

    expect(attachmentApiMocks.chatImportAttachmentData).toHaveBeenCalledOnce();
    expect(attachment).toMatchObject({
      kind: "image",
      name: "shot.png",
      path: ".somniq/uploads/456-shot.png",
      mimeType: "image/png",
    });
    expect(attachment.preview).toBeUndefined();
  });

  it("classifies a native image path as an image after importing it", async () => {
    attachmentApiMocks.chatImportAttachment.mockResolvedValue({
      path: ".somniq/uploads/789-diagram.webp",
      name: "diagram.webp",
      bytes: 12,
    });

    const attachment = await attachmentFromPath("C:\\Downloads\\diagram.webp");

    expect(attachmentApiMocks.chatImportAttachment).toHaveBeenCalledWith("C:\\Downloads\\diagram.webp");
    expect(attachment).toMatchObject({
      kind: "image",
      name: "diagram.webp",
      path: ".somniq/uploads/789-diagram.webp",
      mimeType: "image/webp",
    });
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

  it("disables attachments for a remote Agent session", () => {
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
        onInputChange={() => undefined}
        onAttachmentsChange={() => undefined}
        onSubmit={() => undefined}
        onStop={() => undefined}
        onCancelEdit={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the Git action menu inside the viewport when its toolbar trigger is near the edge", async () => {
    vi.stubGlobal("innerWidth", 360);
    const rectangle = (left: number, top: number, width: number, height: number) => ({
      left, top, right: left + width, bottom: top + height, x: left, y: top, width, height, toJSON() {},
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("chat-git-menu-anchor")) return rectangle(260, 180, 80, 30);
      if (this.classList.contains("chat-git-menu")) return rectangle(260, 0, 340, 220);
      return rectangle(0, 0, 0, 0);
    });
    render(<ChatComposer
      input="" commands={[]} skills={[]} attachments={[]} busy={false} ready editing={false} gitWorkspace={null}
      onInputChange={() => undefined} onAttachmentsChange={() => undefined} onSubmit={() => undefined}
      onStop={() => undefined} onCancelEdit={() => undefined} onHeightChange={() => undefined}
    />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Git menu/ }));
    const menu = screen.getByRole("menu", { name: "Git actions" });
    const left = 260 + Number.parseFloat(menu.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 340).toBeLessThanOrEqual(352);
    expect(Number.parseFloat(menu.style.maxHeight)).toBeLessThan(180);
  });

  it("shows Git in the composer toolbar and preserves branch actions", async () => {
    const user = userEvent.setup();
    const onOpenGit = vi.fn();
    const onSwitchGitBranch = vi.fn();
    const onCreateGitBranch = vi.fn();
    render(
      <ChatComposer
        input=""
        commands={[]}
        skills={[]}
        attachments={[]}
        busy={false}
        ready
        editing={false}
        gitWorkspace={{
          gitAvailable: true,
          isRepository: true,
          workspacePath: "F:\\Agent\\Aris",
          repositoryRoot: "F:\\Agent\\Aris",
          branch: "task/5",
          detached: false,
          ahead: 0,
          behind: 0,
          files: [{
            path: "desktop/src/chat/Chat.tsx",
            staged: false,
            unstaged: true,
            untracked: false,
            conflicted: false,
          }],
          branches: [
            { name: "task/5", current: true },
            { name: "main", current: false },
          ],
          hasConflicts: false,
        }}
        onOpenGit={onOpenGit}
        onRefreshGit={() => undefined}
        onSwitchGitBranch={onSwitchGitBranch}
        onCreateGitBranch={onCreateGitBranch}
        onInputChange={() => undefined}
        onAttachmentsChange={() => undefined}
        onSubmit={() => undefined}
        onStop={() => undefined}
        onCancelEdit={() => undefined}
        onHeightChange={() => undefined}
      />,
    );

    const workspaceBar = screen.getByLabelText("Git workspace");
    expect(workspaceBar.closest(".chat-input-footer")).not.toBeNull();
    expect(within(workspaceBar).queryByText("Aris")).toBeNull();
    expect(within(workspaceBar).getByText("task/5")).toBeTruthy();
    expect(within(workspaceBar).getByText("1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Git menu, task/5" }));
    expect(screen.getByRole("menu", { name: "Git actions" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search branches and actions")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Local branches/ }));
    await user.click(screen.getByRole("menuitem", { name: "main" }));
    expect(onSwitchGitBranch).toHaveBeenCalledWith("main");

    await user.click(screen.getByRole("button", { name: "Git menu, task/5" }));
    await user.click(screen.getByRole("menuitem", { name: "New branch…" }));
    await user.type(screen.getByLabelText("New branch name"), "feature/menu");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreateGitBranch).toHaveBeenCalledWith("feature/menu");

    await user.click(screen.getByRole("button", { name: "Git menu, task/5" }));
    await user.click(screen.getByRole("menuitem", { name: "View changes and commit…" }));
    expect(onOpenGit).toHaveBeenCalledOnce();
  });
});

const SKILLS: SkillMeta[] = [
  { name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" },
  { name: "review", description: "Review code", path: "review/SKILL.md" },
];

const GROUPED_MODELS = [
  "MiniMax-M3", "gpt-5.6-luna", "deepseek-v4.1-flash", "MiniMax-M3.1-Flash-Preview",
  "gpt-6-astra", "gpt-6.1-sol", "laya-triage", "longcat-2.5-preview-free", "mimo-v2.6-flash",
].map((value) => ({ value, label: value }));

function modelComposer(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  return <ChatComposer input="" commands={[]} skills={[]} attachments={[]} busy={false} ready editing={false}
    onInputChange={() => undefined} onAttachmentsChange={() => undefined} onSubmit={() => undefined}
    onStop={() => undefined} onCancelEdit={() => undefined} onHeightChange={() => undefined}
    modelName="gpt-6.1-sol" modelOptions={GROUPED_MODELS} canSwitchModel onModelChange={vi.fn()} {...overrides} />;
}

describe("ChatComposer model series", () => {
  it("opens only the current series and preserves model labels, order, and selection", async () => {
    const user = userEvent.setup();
    render(modelComposer());
    const trigger = screen.getByRole("button", { name: "gpt-6.1-sol" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Switch model" });
    const groups = within(menu).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["MiniMax", "GPT", "DeepSeek", "Laya", "LongCat", "MiMo"]);
    expect(within(groups[1]).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol"]);
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(menu).getByRole("menuitem", { name: "GPT" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: "MiniMax" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(menu).getByRole("menuitemradio", { name: "gpt-6.1-sol" }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).queryByRole("textbox")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("switches between series, collapses them, and restores the current series when reopening", async () => {
    const user = userEvent.setup();
    render(modelComposer());
    const trigger = screen.getByRole("button", { name: "gpt-6.1-sol" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Switch model" });
    const minimax = within(menu).getByRole("menuitem", { name: "MiniMax" });
    await user.click(minimax);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview"]);
    expect(within(menu).getByRole("menuitem", { name: "GPT" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("menu")).toBe(menu);
    await user.click(minimax);
    expect(within(menu).queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(minimax.getAttribute("aria-expanded")).toBe("false");
    minimax.focus();
    await user.keyboard("{Enter}");
    expect(minimax.getAttribute("aria-expanded")).toBe("true");
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "gpt-6.1-sol" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "MiniMax" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps routed and unknown models selectable and sends the original model ID", async () => {
    useStore.setState({ language: "cn" });
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    render(modelComposer({
      onModelChange,
      modelOptions: [
        { value: "openai/GPT-6.1-sol", label: "Gateway GPT" },
        { value: "custom-research", label: "My research model" },
      ],
      modelName: "custom-research",
    }));
    await user.click(screen.getByRole("button", { name: "custom-research" }));
    const unknown = screen.getByRole("group", { name: "其他模型" });
    expect(within(unknown).getByRole("menuitemradio", { name: "My research model" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "GPT" }));
    await user.click(within(screen.getByRole("group", { name: "GPT" })).getByRole("menuitemradio", { name: "Gateway GPT" }));
    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith("openai/GPT-6.1-sol");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the model control disabled while saving or when switching is unavailable", async () => {
    const user = userEvent.setup();
    const { rerender } = render(modelComposer({ modelBusy: true }));
    const trigger = screen.getByRole("button", { name: "gpt-6.1-sol" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(modelComposer({ canSwitchModel: false }));
    expect(trigger.disabled).toBe(true);
  });
});

describe("ChatComposer combined model and reasoning panel", () => {
  const reasoning = {
    reasoningSupported: true,
    reasoningEffort: "high",
    reasoningOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    onReasoningEffortChange: vi.fn(),
  };

  it("keeps models selectable when reasoning is provider-controlled or unsupported", async () => {
    const user = userEvent.setup();
    const { rerender } = render(modelComposer({ ...reasoning, reasoningApplied: false }));
    const trigger = screen.getByRole("button", { name: "gpt-6.1-sol · Provider default" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await user.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Model and reasoning effort" });
    expect(within(panel).getByRole("menu", { name: "Switch model" })).toBeTruthy();
    expect(within(panel).getByText("Provider default")).toBeTruthy();
    expect(within(panel).queryByRole("slider")).toBeNull();
    rerender(modelComposer({ ...reasoning, reasoningSupported: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "gpt-6.1-sol" }));
    expect(screen.getByRole("menu", { name: "Switch model" })).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows one entry and one panel with folded models and a slider, then restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(modelComposer({ ...reasoning, onReasoningEffortChange: onChange }));
    const trigger = screen.getByRole("button", { name: "gpt-6.1-sol · High" });
    expect(screen.queryByRole("button", { name: "gpt-6.1-sol" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).toBeNull();
    await user.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Model and reasoning effort" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(panel).getByRole("slider").getAttribute("max")).toBe("5");
    expect(within(panel).getByRole("menuitem", { name: "GPT" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(panel).queryByRole("textbox")).toBeNull();
    within(panel).getByRole("slider").focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allows reasoning for a fixed model and updates the combined label after saving", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function FixedModel() {
      const [effort, setEffort] = useState("high");
      return modelComposer({ ...reasoning, canSwitchModel: false, reasoningEffort: effort,
        onReasoningEffortChange: (value) => { onChange(value); setEffort(value); } });
    }
    render(<FixedModel />);
    await user.click(screen.getByRole("button", { name: "gpt-6.1-sol · High" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    slider.focus();
    fireEvent.change(slider, { target: { value: "5" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(screen.getByRole("button", { name: "gpt-6.1-sol · Max" })).toBeTruthy());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("max");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("locks reasoning during a response while allowing the next-turn model choice", async () => {
    const user = userEvent.setup();
    const { rerender } = render(modelComposer({ ...reasoning, busy: true }));
    await user.click(screen.getByRole("button", { name: "gpt-6.1-sol · High" }));
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Adjust after the response finishes")).toBeTruthy();
    expect((screen.getByRole("menuitemradio", { name: "gpt-6-astra" }) as HTMLButtonElement).disabled).toBe(false);
    for (const state of [{ modelBusy: true }, { reasoningBusy: true }]) {
      rerender(modelComposer({ ...reasoning, ...state }));
      expect((screen.getByRole("button", { name: "gpt-6.1-sol · High" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByRole("menuitemradio", { name: "gpt-6-astra" }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("reopens with the new model's actual levels and never saves a strength when selecting a model", async () => {
    useStore.setState({ language: "cn" });
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onModelChange = vi.fn();
    const { rerender } = render(modelComposer({ ...reasoning, onModelChange, onReasoningEffortChange: onChange }));
    await user.click(screen.getByRole("button", { name: "gpt-6.1-sol · 高" }));
    await user.click(screen.getByRole("menuitem", { name: "DeepSeek" }));
    await user.click(screen.getByRole("menuitemradio", { name: "deepseek-v4.1-flash" }));
    expect(onModelChange).toHaveBeenCalledWith("deepseek-v4.1-flash");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(modelComposer({ ...reasoning, modelName: "deepseek-v4.1-flash", reasoningOptions: ["low", "medium", "high"],
      reasoningEffort: "medium", onReasoningEffortChange: onChange }));
    await user.click(screen.getByRole("button", { name: "deepseek-v4.1-flash · 中" }));
    expect(screen.getByRole("slider").getAttribute("max")).toBe("2");
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("中");
    expect(screen.getByRole("menuitem", { name: "DeepSeek" }).getAttribute("aria-expanded")).toBe("true");
  });
});

function ComposerHarness({
  commands = [],
  skills = SKILLS,
  busy = false,
  onSubmit = () => undefined,
  onStop = () => undefined,
}: {
  commands?: DesktopCommandSpec[];
  skills?: SkillMeta[];
  busy?: boolean;
  onSubmit?: () => void;
  onStop?: () => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  return (
    <ChatComposer
      input={input}
      commands={commands}
      skills={skills}
      attachments={attachments}
      busy={busy}
      ready
      editing={false}
      onInputChange={setInput}
      onAttachmentsChange={setAttachments}
      onSubmit={onSubmit}
      onStop={onStop}
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

  it("allows drafting while the current response finishes without submitting another turn", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <ComposerHarness busy onSubmit={onSubmit} onStop={onStop} />,
    );
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    expect(textbox.disabled).toBe(false);
    expect(textbox.getAttribute("aria-busy")).toBe("true");
    await user.type(textbox, "question for the next turn");
    await user.keyboard("{Enter}");

    expect(textbox.value).toBe("question for the next turn");
    expect(onSubmit).not.toHaveBeenCalled();
    const stopButton = screen.getByRole("button", { name: "Stop response" });
    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledOnce();

    rerender(<ComposerHarness busy={false} onSubmit={onSubmit} onStop={onStop} />);
    expect(textbox.value).toBe("question for the next turn");
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
