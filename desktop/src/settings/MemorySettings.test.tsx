// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStore } from "../store";
import MemorySettings from "./MemorySettings";

describe("MemorySettings", () => {
  afterEach(() => {
    cleanup();
    useStore.setState({ currentProject: null });
  });

  it("browses direct v2 content across R0, R1, R2, and R3", async () => {
    render(<MemorySettings language="en" />);

    await screen.findByText("Preview memory result");
    expect(screen.getByRole("tab", { name: /Research atoms/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /Authoritative sessions/ }));
    await screen.findByText(/experiment should compare retrieval quality/);

    fireEvent.click(screen.getByRole("tab", { name: /Research episodes/ }));
    await screen.findByText(/Compare Top-5 recall/);

    fireEvent.click(screen.getByRole("tab", { name: /Research profile/ }));
    await screen.findByText(/The user values reproducible evidence/);
  });

  it("keeps long authoritative conversations compact until explicitly expanded", async () => {
    render(<MemorySettings language="en" />);

    fireEvent.click(screen.getByRole("tab", { name: /Authoritative sessions/ }));
    await screen.findByText(/experiment should compare retrieval quality/);

    const content = document.querySelector(".memory-entry-content");
    expect(content?.classList.contains("is-collapsed")).toBe(true);

    const expand = screen.getByRole("button", { name: "Show full entry" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);

    expect(content?.classList.contains("is-collapsed")).toBe(false);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
  });

  it("supports search and inspection of reviewed v2 atoms without exposing mutations", async () => {
    render(<MemorySettings language="en" />);

    fireEvent.change(screen.getByPlaceholderText("Search facts, conclusions, or conversations"), {
      target: { value: "preferred method" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const result = await screen.findByText("Preview memory result");
    expect(screen.queryByText("Legacy · read-only")).toBeNull();
    // v2 atoms are inspect-only. (The lessons list further down the page has
    // its own delete, which is the point of that section.)
    const card = result.closest(".memory-entry-card") as HTMLElement;
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("lists lessons with off and two-step delete controls", async () => {
    render(<MemorySettings language="en" />);
    const section = screen.getByRole("region", { name: "Lessons from errors" });
    expect(within(section).getByText(/encoding='gbk'/)).toBeTruthy();
    expect(within(section).getByText(/2 lessons, 1 active/)).toBeTruthy();

    const deletes = within(section).getAllByRole("button", { name: "Delete" });
    fireEvent.click(deletes[0]);
    const confirm = within(section).getByRole("button", { name: "Confirm delete" });
    fireEvent.click(confirm);
    expect(within(section).queryByText(/encoding='gbk'/)).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Restore" }));
    expect(within(section).getByText(/Active ·/)).toBeTruthy();
  });

  it("drops the provider, extraction model, and sidecar lifecycle controls", () => {
    render(<MemorySettings language="en" />);

    for (const label of ["Default provider mode", "Current project mode", "Memory model", "Recall strategy"]) {
      expect(screen.queryByRole("combobox", { name: label })).toBeNull();
    }
    for (const label of ["Start", "Stop", "Restart", "Connection test"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("shows the recall budget split and why candidates were dropped", async () => {
    render(<MemorySettings language="en" />);

    fireEvent.change(screen.getByLabelText("Recall preview query"), {
      target: { value: "what was the p95" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview recall" }));

    await screen.findByText("5,182 / 6,000 chars injected");
    // R0 receives the shared remaining budget rather than a fixed quota.
    expect(screen.getByText("Shared remaining budget")).toBeTruthy();
    expect(screen.getByText("/ 300 chars")).toBeTruthy();
    expect(screen.getAllByText("Duplicate").length).toBe(2);
    expect(screen.getByText("Not resident")).toBeTruthy();
    expect(screen.getByText("Over budget")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await screen.findByText(/SomniQ recalled research memory/);
  });

  it("starts v2 cleanly instead of replaying legacy derived memory", () => {
    render(<MemorySettings language="en" />);

    expect(screen.getByText("Memory mode")).toBeTruthy();
    expect(screen.getByText("Uses only reviewed memory and keeps source conversations.")).toBeTruthy();
    expect(screen.getByText("Memory with screening, review, or sync failures stays out of conversations.")).toBeTruthy();
    for (const label of ["Backfill history", "Re-derive R1–R3", "Requeue"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });
});
