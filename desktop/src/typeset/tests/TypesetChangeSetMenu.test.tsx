// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TypesetChangeSetMenu, { type ChangeSetMenuCopy, type ChangeSetMenuFile } from "../TypesetChangeSetMenu";

const files: ChangeSetMenuFile[] = [
  { path: "ch1.tex", label: "ch1.tex", title: "ch1.tex", answered: true, active: false },
  { path: "ch2.tex", label: "ch2.tex", title: "ch2.tex", answered: false, active: true },
  { path: "figs/old.pdf", label: "old.pdf · deleted", title: "figs/old.pdf · deleted", answered: false, active: false },
];

const copy: ChangeSetMenuCopy = {
  headline: "3 files changed outside the editor",
  actor: "Changed by Chat",
  actorTitle: "chat · chat",
  progress: "1 / 3",
  comments: null,
  explanation: "Review is required only for changes made by Chat.",
  carried: null,
  carriedTitle: null,
  menuLabel: "Change set",
  selectFile: "Choose a file to review",
  acceptAll: "Accept change set",
  rejectAll: "Reject change set",
  apply: "Apply reviewed changes",
};

function renderMenu(overrides: Partial<ComponentProps<typeof TypesetChangeSetMenu>> = {}) {
  return render(
    <TypesetChangeSetMenu
      files={files}
      copy={copy}
      busy={false}
      fullyReviewed={false}
      actionsInMenu
      onSelect={vi.fn()}
      onAcceptAll={vi.fn()}
      onRejectAll={vi.fn()}
      onApply={vi.fn()}
      {...overrides}
    />,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Choose a file to review" }));
  return screen.getByRole("dialog", { name: "Change set" });
}

describe("TypesetChangeSetMenu", () => {
  afterEach(() => cleanup());

  it("names the file being reviewed on the bar and lists the rest behind it", () => {
    renderMenu();

    // The trigger replaced a headline, a progress badge and a chip strip.
    const trigger = screen.getByRole("button", { name: "Choose a file to review" });
    expect(trigger.textContent).toContain("ch2.tex");
    expect(trigger.textContent).toContain("1 / 3");
    expect(screen.queryByRole("menuitem", { name: "ch1.tex" })).toBeNull();

    const menu = openMenu();
    expect(within(menu).getByText("3 files changed outside the editor")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "ch1.tex" }).classList.contains("reviewed")).toBe(true);
    expect(within(menu).getByRole("menuitem", { name: "ch2.tex" }).classList.contains("active")).toBe(true);
    expect(within(menu).getByRole("menuitem", { name: "old.pdf · deleted" })).toBeTruthy();
  });

  it("selects a file and closes", () => {
    const onSelect = vi.fn();
    renderMenu({ onSelect });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "ch1.tex" }));
    expect(onSelect).toHaveBeenCalledWith("ch1.tex");
    expect(screen.queryByRole("dialog", { name: "Change set" })).toBeNull();
  });

  /**
   * The whole point of the menu. A file review already owns the bar's right
   * edge with its own accept/reject, so the transaction's blanket answers hide
   * behind the trigger — one diff, one visible pair of answers.
   */
  it("keeps the change-set answers out of the bar while a file review owns it", () => {
    const onAcceptAll = vi.fn();
    renderMenu({ onAcceptAll });

    expect(screen.queryByRole("button", { name: "Accept change set" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject change set" })).toBeNull();

    fireEvent.click(within(openMenu()).getByRole("button", { name: "Accept change set" }));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
  });

  it("puts them back on the bar when no file review is beside them", () => {
    renderMenu({ actionsInMenu: false });

    expect(screen.getByRole("button", { name: "Accept change set" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject change set" })).toBeTruthy();
    // Never in both places at once: one label, one control.
    expect(within(openMenu()).queryByRole("button", { name: "Accept change set" })).toBeNull();
  });

  it("offers only the terminal action once every file has an answer", () => {
    const onApply = vi.fn();
    renderMenu({ actionsInMenu: false, fullyReviewed: true, onApply });

    expect(screen.queryByRole("button", { name: "Accept change set" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  /**
   * A transaction from an earlier action that nobody answered is left on disk
   * rather than folded into this one. Saying nothing would leave the reviewer
   * believing the queue in front of them is everything outstanding.
   */
  it("names the earlier review this one left in place", () => {
    renderMenu({
      copy: { ...copy, carried: "1 earlier unreviewed change was left in place when this one started.", carriedTitle: "ch9.tex" },
    });

    const note = within(openMenu()).getByText(/1 earlier unreviewed change/);
    expect(note.getAttribute("title")).toBe("ch9.tex");
  });

  it("says nothing about carried work when there is none", () => {
    renderMenu();

    expect(within(openMenu()).queryByText(/left in place/)).toBeNull();
  });

  it("does not answer the transaction while one is already being written", () => {
    const onAcceptAll = vi.fn();
    renderMenu({ actionsInMenu: false, busy: true, onAcceptAll });

    const accept = screen.getByRole("button", { name: "Accept change set" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(accept);
    expect(onAcceptAll).not.toHaveBeenCalled();
  });
});
