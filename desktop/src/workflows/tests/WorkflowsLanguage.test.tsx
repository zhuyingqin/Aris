// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useStore, type Language } from "../../store";
import Workflows from "../Workflows";
import { WORKFLOWS_COPY } from "../i18n";

const CJK = /[一-鿿]/;

/** Text nodes that still carry Chinese, excluding what the user typed. */
function chineseText(typed: string) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.replace(typed, "") ?? "";
    if (CJK.test(value)) found.push(value.trim());
  }
  return found;
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    tab: "workflows",
    currentProject: {
      id: "workflow-language-project",
      name: "Workflow language",
      path: "browser preview",
      addedAt: 0,
      lastOpenedAt: 0,
    },
    pendingChatInput: null,
    pendingChatHandoff: null,
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ language: "cn" });
});

describe.each<Language>(["en", "es"])("Workflows in %s", (language) => {
  it("renders the new-workflow form and the first stage without Chinese copy", async () => {
    useStore.setState({ language });
    const copy = WORKFLOWS_COPY[language];
    const user = userEvent.setup();
    render(<Workflows />);

    // A project with no workflows opens straight onto the new-workflow form.
    const topic = "Large language models for time series";
    await user.type(await screen.findByPlaceholderText(copy.panels.newWorkflow.topicPlaceholder), topic);
    expect(chineseText(topic)).toEqual([]);

    await user.click(screen.getByRole("button", { name: copy.panels.newWorkflow.create }));
    await screen.findByRole("heading", { name: copy.common.stageText["scope-and-plan"].title });
    expect(chineseText(topic)).toEqual([]);
  });
});
