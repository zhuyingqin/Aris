// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";
import ImageWorkflowPanel from "../ImageWorkflowPanel";
import { imageWorkflowCallsFromTurns, layoutImageWorkflow } from "../imageWorkflowModel";

vi.mock("../ChatImagePreview", () => ({
  default: ({ src, alt, title, onClick }: { src: string; alt: string; title?: string; onClick?: () => void }) => (
    onClick
      ? <button type="button" aria-label={title ?? alt} onClick={onClick}><img src={src} alt={alt} /></button>
      : <img src={src} alt={alt} />
  ),
}));

const turns: ChatTurn[] = [
  {
    id: "user-1",
    role: "user",
    blocks: [{ kind: "text", text: "Generate an ESN architecture diagram" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    blocks: [{
      kind: "tool",
      id: "image-call-1",
      name: "ChatGptWebImage",
      input: JSON.stringify({ prompt: "ESN diagram with fixed random reservoir" }),
      output: JSON.stringify({ images: [{ path: "F:/project/esn-v1.png", width: 1024, height: 768, sizeBytes: 204800 }] }),
    }],
  },
];

// A follow-up call that feeds the first image back in as a reference.
const revision: ChatTurn = {
  id: "assistant-2",
  role: "assistant",
  blocks: [{
    kind: "tool",
    name: "ChatGptWebImage",
    input: JSON.stringify({ prompt: "Second direction", files: ["F:\\project\\ESN-v1.png"] }),
    output: JSON.stringify({ images: [{ path: "F:/project/esn-v2.png" }] }),
  }],
};

describe("ImageWorkflowPanel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("projects only real image prompts and outputs from the Chat transcript", () => {
    expect(imageWorkflowCallsFromTurns(turns)).toEqual([{
      id: "assistant-1-image-call-1",
      promptNodeId: "assistant-1-image-call-1-prompt",
      prompt: "ESN diagram with fixed random reservoir",
      referencePaths: [],
      sourceIds: [],
      aspectRatio: null,
      model: null,
      generations: [{
        id: "assistant-1-image-call-1-image-0",
        path: "F:/project/esn-v1.png",
        status: "complete",
        width: 1024,
        height: 768,
        sizeBytes: 204800,
      }],
    }]);
  });

  it("links a revision back to the version it was generated from, ignoring path casing and separators", () => {
    const calls = imageWorkflowCallsFromTurns([...turns, revision]);
    expect(calls[1].sourceIds).toEqual(["assistant-1-image-call-1-image-0"]);

    const layout = layoutImageWorkflow(calls);
    const lineage = layout.edges.filter((edge) => edge.kind === "lineage");
    expect(lineage).toHaveLength(1);
    expect(lineage[0].id).toBe("lineage-assistant-1-image-call-1-image-0-assistant-2-0");
    // Every node has to fit inside the reported stage bounds or it lands off-canvas.
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("shows an honest empty state and prunes stale canvas metadata without inventing nodes", async () => {
    localStorage.setItem("somniq-image-workflow-v1:empty", JSON.stringify({
      acceptedId: "ghost-image",
      drafts: { "ghost-node": { title: "Ghost" } },
      revisions: [{ id: "old-phantom-branch" }],
    }));
    const { container } = render(
      <ImageWorkflowPanel sessionId="empty" turns={[]} language="en" onSendToChat={() => undefined} />,
    );
    expect(screen.getByText("No image nodes in this conversation")).toBeTruthy();
    expect(container.querySelectorAll(".image-flow-node")).toHaveLength(0);
    await waitFor(() => expect(localStorage.getItem("somniq-image-workflow-v1:empty")).toBe(JSON.stringify({
      acceptedId: null,
      drafts: {},
    })));
  });

  it("offers a first-generation starter when the canvas is empty", async () => {
    const onSendToChat = vi.fn();
    render(<ImageWorkflowPanel sessionId="starter" turns={[]} language="en" onSendToChat={onSendToChat} />);

    await userEvent.click(screen.getByRole("button", { name: /Draft the first generation/ }));

    expect(onSendToChat.mock.calls[0][0]).toContain("ChatGptWebImage");
    expect(await screen.findByText("Added to composer — press Enter")).toBeTruthy();
  });

  it("edits canvas metadata without changing the original transcript and sends the edited prompt to Chat", async () => {
    const onSendToChat = vi.fn();
    const { container } = render(
      <ImageWorkflowPanel sessionId="chat-esn" turns={turns} language="en" onSendToChat={onSendToChat} />,
    );

    expect(container.querySelectorAll(".image-flow-node")).toHaveLength(2);
    // The newest version is selected on open, so reach the prompt node first.
    await userEvent.click(container.querySelector(".image-flow-prompt") as HTMLElement);
    await userEvent.type(screen.getByLabelText("Node title"), "Corrected ESN prompt");
    const content = screen.getByLabelText("Prompt content");
    await userEvent.clear(content);
    await userEvent.type(content, "ESN diagram with a correct fixed-input legend");
    await userEvent.click(screen.getByRole("button", { name: /Send to Chat composer/ }));

    expect(onSendToChat.mock.calls[0][0]).toContain("ESN diagram with a correct fixed-input legend");
    expect(screen.getByText("ESN diagram with fixed random reservoir")).toBeTruthy();
    expect(localStorage.getItem("somniq-image-workflow-v1:chat-esn")).toContain("Corrected ESN prompt");
    expect(container.querySelectorAll(".image-flow-node")).toHaveLength(2);
  });

  it("selects the newest version when a generation arrives", async () => {
    const { container, rerender } = render(
      <ImageWorkflowPanel sessionId="follow" turns={turns} language="en" onSendToChat={() => undefined} />,
    );
    await waitFor(() => expect(container.querySelector(".image-flow-generation.is-selected")).toBeTruthy());
    expect(screen.getByText("Image output V1")).toBeTruthy();

    rerender(<ImageWorkflowPanel sessionId="follow" turns={[...turns, revision]} language="en" onSendToChat={() => undefined} />);

    await waitFor(() => {
      const selected = container.querySelector(".image-flow-generation.is-selected");
      expect(selected?.textContent).toContain("Image output V2");
    });
  });

  it("moves between nodes with the arrow keys", async () => {
    const { container } = render(
      <ImageWorkflowPanel sessionId="keys" turns={[...turns, revision]} language="en" onSendToChat={() => undefined} />,
    );
    const nodes = () => [...container.querySelectorAll(".image-flow-node")];
    const selectedText = () => container.querySelector(".image-flow-node.is-selected")?.textContent ?? "";

    const selected = nodes().find((node) => node.classList.contains("is-selected"));
    (selected as HTMLElement).focus();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(selectedText()).toContain("Prompt 2"));

    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(selectedText()).toContain("Prompt 1"));

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(selectedText()).toContain("Image output V1"));
  });

  it("steps through generated images inside the large preview", async () => {
    render(<ImageWorkflowPanel sessionId="zoom" turns={[...turns, revision]} language="en" onSendToChat={() => undefined} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Enlarge image" })[0]);

    const dialog = screen.getByRole("dialog", { name: "Enlarge image" });
    expect(dialog.textContent).toContain("1 / 2");

    await userEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("dialog", { name: "Enlarge image" }).textContent).toContain("2 / 2");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Enlarge image" })).toBeNull();
  });

  it("compares real generated versions in labelled A/B slots", async () => {
    render(<ImageWorkflowPanel sessionId="compare" turns={[...turns, revision]} language="en" onSendToChat={() => undefined} />);
    const compareButtons = screen.getAllByRole("button", { name: "Add to compare" });
    await userEvent.click(compareButtons[0]);
    await userEvent.click(compareButtons[1]);

    const tray = screen.getByRole("region", { name: "Version compare" });
    expect(tray.textContent).toContain("A · V1");
    expect(tray.textContent).toContain("B · V2");

    await userEvent.click(screen.getByRole("button", { name: "Swap A / B" }));
    expect(screen.getByRole("region", { name: "Version compare" }).textContent).toContain("A · V2");

    await userEvent.click(screen.getByRole("button", { name: "Remove from compare: V2" }));
    expect(screen.getByRole("region", { name: "Version compare" }).textContent).not.toContain("A · V2");
  });

  it("collapses the inspector to give the canvas the full pane", async () => {
    const { container } = render(
      <ImageWorkflowPanel sessionId="collapse" turns={turns} language="en" onSendToChat={() => undefined} />,
    );
    expect(container.querySelector(".image-workflow-inspector")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Collapse editor" }));
    expect(container.querySelector(".image-workflow-inspector")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Expand editor" }));
    expect(container.querySelector(".image-workflow-inspector")).toBeTruthy();
  });
});
