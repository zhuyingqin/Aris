// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";
import ImageWorkflowPanel, { imageWorkflowCallsFromTurns } from "../ImageWorkflowPanel";

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
      output: JSON.stringify({ images: [{ path: "F:/project/esn-v1.png" }] }),
    }],
  },
];

describe("ImageWorkflowPanel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("projects only real image prompts and outputs from the Chat transcript", () => {
    expect(imageWorkflowCallsFromTurns(turns)).toEqual([{
      id: "assistant-1-image-call-1",
      promptNodeId: "assistant-1-image-call-1-prompt",
      prompt: "ESN diagram with fixed random reservoir",
      referencePaths: [],
      generations: [{
        id: "assistant-1-image-call-1-image-0",
        path: "F:/project/esn-v1.png",
        status: "complete",
      }],
    }]);
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

  it("edits canvas metadata without changing the original transcript and sends the edited prompt to Chat", async () => {
    const onSendToChat = vi.fn();
    const { container } = render(
      <ImageWorkflowPanel sessionId="chat-esn" turns={turns} language="en" onSendToChat={onSendToChat} />,
    );

    expect(container.querySelectorAll(".image-flow-node")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("Node title"), "Corrected ESN prompt");
    const content = screen.getByLabelText("Prompt content");
    await userEvent.clear(content);
    await userEvent.type(content, "ESN diagram with a correct fixed-input legend");
    await userEvent.click(screen.getByRole("button", { name: "Send to Chat for a new version" }));

    expect(onSendToChat.mock.calls[0][0]).toContain("ESN diagram with a correct fixed-input legend");
    expect(screen.getByText("ESN diagram with fixed random reservoir")).toBeTruthy();
    expect(localStorage.getItem("somniq-image-workflow-v1:chat-esn")).toContain("Corrected ESN prompt");
    expect(container.querySelectorAll(".image-flow-node")).toHaveLength(2);
  });

  it("opens generated images in an in-app large preview", async () => {
    render(<ImageWorkflowPanel sessionId="zoom" turns={turns} language="en" onSendToChat={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Enlarge image" }));
    expect(screen.getByRole("dialog", { name: "Enlarge image" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close large preview" }));
    expect(screen.queryByRole("dialog", { name: "Enlarge image" })).toBeNull();
  });

  it("compares only real generated versions", async () => {
    const second: ChatTurn = {
      id: "assistant-2",
      role: "assistant",
      blocks: [{
        kind: "tool",
        name: "ChatGptWebImage",
        input: JSON.stringify({ prompt: "Second direction", files: ["F:/project/esn-v1.png"] }),
        output: JSON.stringify({ images: [{ path: "F:/project/esn-v2.png" }] }),
      }],
    };
    render(<ImageWorkflowPanel sessionId="compare" turns={[...turns, second]} language="en" onSendToChat={() => undefined} />);
    const compareButtons = screen.getAllByRole("button", { name: "Add to compare" });
    await userEvent.click(compareButtons[0]);
    await userEvent.click(compareButtons[1]);
    expect(screen.getByRole("region", { name: "Version compare" })).toBeTruthy();
  });
});
