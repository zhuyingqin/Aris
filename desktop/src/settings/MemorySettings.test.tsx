// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStore } from "../store";
import MemorySettings from "./MemorySettings";

describe("MemorySettings", () => {
  afterEach(() => {
    cleanup();
    useStore.setState({ currentProject: null });
  });

  it("browses actual content across R0, R1, R2, and R3", async () => {
    render(<MemorySettings language="en" />);

    await screen.findByText("Preview memory result");
    expect(screen.getByRole("tab", { name: /Research atoms/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /Authoritative sessions/ }));
    await screen.findByText(/experiment should compare retrieval quality/);

    fireEvent.click(screen.getByRole("tab", { name: /Research episodes/ }));
    await screen.findByText(/Compare Top-5 recall/);

    fireEvent.click(screen.getByRole("tab", { name: /Research constitution/ }));
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

  it("supports search and correction of derived atoms", async () => {
    render(<MemorySettings language="en" />);

    fireEvent.change(screen.getByPlaceholderText("Search facts, conclusions, or conversations"), {
      target: { value: "preferred method" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Preview memory result");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Preview memory result"), {
      target: { value: "Corrected preview memory" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText("Corrected preview memory");
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

    await screen.findByText("5,182 / 6,000 chars");
    // R0 receives the shared remaining budget rather than a fixed quota.
    expect(screen.getByText("Shared remaining budget")).toBeTruthy();
    expect(screen.getByText("/ 300 chars")).toBeTruthy();
    expect(screen.getAllByText("Duplicate").length).toBe(2);
    expect(screen.getByText("Not standing")).toBeTruthy();
    expect(screen.getByText("Over quota")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await screen.findByText(/SomniQ recalled research memory/);
  });

  it("offers safe Session backfill for research memory", async () => {
    render(<MemorySettings language="en" />);

    expect(screen.getByText(/Workflow Sessions are excluded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/8 sessions · 0 already backfilled/);

    fireEvent.click(screen.getByRole("button", { name: "Backfill history" }));
    await screen.findByText(/Completed: 8 sessions \/ 32 messages/);
  });
});
