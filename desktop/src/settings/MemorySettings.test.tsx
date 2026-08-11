// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigView } from "../types";
import { useStore } from "../store";
import MemorySettings from "./MemorySettings";

const CONFIG = {
  memoryProviderMode: "tencentdb",
  memoryRecallStrategy: "keyword",
  memoryModel: "gpt-memory",
  verifiedExecutors: [
    {
      provider: "openai",
      model: "gpt-memory",
      baseUrl: "https://example.invalid/v1",
    },
  ],
} as ConfigView;

describe("MemorySettings", () => {
  afterEach(() => {
    cleanup();
    useStore.setState({ currentProject: null });
  });

  it("offers only builtin and tencentdb provider modes", () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);

    const provider = screen.getByRole("combobox", { name: "Default provider mode" });
    expect([...provider.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "builtin",
      "tencentdb",
    ]);
  });

  it("supports a provider override for the current project", async () => {
    useStore.setState({
      currentProject: {
        id: "project-a",
        name: "Project A",
        path: "C:/project-a",
        addedAt: 1,
        lastOpenedAt: 1,
      },
    });
    render(<MemorySettings language="en" initialConfig={{ ...CONFIG, memoryProviderMode: "builtin", memoryProjectModes: {} }} />);

    const projectMode = screen.getByRole("combobox", { name: /Current project mode/ }) as HTMLSelectElement;
    expect(projectMode.value).toBe("inherit");
    fireEvent.change(projectMode, { target: { value: "tencentdb" } });

    await screen.findByText("Memory settings saved.");
    expect(projectMode.value).toBe("tencentdb");
    expect((screen.getByRole("combobox", { name: "Default provider mode" }) as HTMLSelectElement).value).toBe("builtin");
  });

  it("keeps hybrid gated until recall connection succeeds", async () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);
    const hybrid = screen.getByRole("option", { name: "hybrid" }) as HTMLOptionElement;
    expect(hybrid.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Connection test" }));
    await screen.findByText("Preview connection is healthy");
    expect(hybrid.disabled).toBe(false);
  });

  it("browses actual content across L0, L1, L2, and L3", async () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);

    await screen.findByText("Preview memory result");
    expect(screen.getByRole("tab", { name: /Research atoms/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /Authoritative sessions/ }));
    await screen.findByText(/experiment should compare retrieval quality/);

    fireEvent.click(screen.getByRole("tab", { name: /Research episodes/ }));
    await screen.findByText(/Compare TencentDB and builtin Top-5/);

    fireEvent.click(screen.getByRole("tab", { name: /Research constitution/ }));
    await screen.findByText(/The user values reproducible evidence/);
  });

  it("keeps long authoritative conversations compact until explicitly expanded", async () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);

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

  it("supports preview search, correction, and migration preview", async () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);

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

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/4 hot memory/);
  });

  it("omits the internal status and local data panel", () => {
    render(<MemorySettings language="en" initialConfig={CONFIG} />);

    expect(screen.queryByText("Status and local data")).toBeNull();
    expect(screen.queryByText("Outbox")).toBeNull();
    expect(screen.queryByText("Dead letter")).toBeNull();
  });

  it("shows the recall budget split and why candidates were dropped", async () => {
    render(<MemorySettings language="en" initialConfig={{ ...CONFIG, memoryProviderMode: "builtin" }} />);

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

  it("offers safe Session backfill for builtin research memory", async () => {
    render(<MemorySettings language="en" initialConfig={{ ...CONFIG, memoryProviderMode: "builtin" }} />);

    expect(screen.getByText(/Workflow Sessions are excluded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/8 sessions · 0 already backfilled/);

    fireEvent.click(screen.getByRole("button", { name: "Backfill history" }));
    await screen.findByText(/Completed: 8 sessions \/ 32 messages/);
  });
});
