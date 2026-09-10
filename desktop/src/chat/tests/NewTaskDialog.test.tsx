// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewTaskDialog from "../NewTaskDialog";

const projects = [
  { id: "alpha", name: "Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 2 },
  { id: "beta", name: "Beta", path: "C:/Beta", addedAt: 1, lastOpenedAt: 2 },
];

afterEach(cleanup);

describe("NewTaskDialog", () => {
  it("creates a local SomniQ task in the selected project", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(
      <NewTaskDialog
        language="en"
        projects={projects}
        initialProjectId="alpha"
        onCancel={() => undefined}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    expect(screen.getByText("Run locally with SomniQ")).toBeTruthy();
    expect(screen.getByText("Independent Reviewer checks the result")).toBeTruthy();
    expect(screen.queryByText(/inherit/i)).toBeNull();

    const create = screen.getByRole("button", { name: "Save" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("What should we work on?"), "Compare the two baselines");
    await user.selectOptions(screen.getByLabelText("Target"), "beta");
    await user.click(create);

    expect(onCreate).toHaveBeenCalledWith("beta", "Compare the two baselines");
  });

  it("closes on Escape without creating a task", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCreate = vi.fn();

    render(
      <NewTaskDialog
        language="cn"
        projects={projects}
        initialProjectId="alpha"
        onCancel={onCancel}
        onCreate={onCreate}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
