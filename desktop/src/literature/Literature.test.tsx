// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import Literature from "./Literature";

afterEach(() => {
  cleanup();
});

describe("Literature library", () => {
  it("renders the library workspace and switches detail tabs", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    expect(screen.getAllByText("Agentic Literature Review: Planning, Retrieval, and Grounded Synthesis").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Agent Notes" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Agent Notes" }));
    expect(screen.getByText("Agent Summary")).toBeTruthy();
    expect(screen.getByText("Keep for close reading and use as the interaction baseline.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "PDF" }));
    expect(screen.getByText("PDF saved")).toBeTruthy();
  });

  it("creates a saved search candidate from the search form", async () => {
    const user = userEvent.setup();
    render(<Literature />);

    const searchBox = screen.getByLabelText("Search query");
    await user.clear(searchBox);
    await user.type(searchBox, "retrieval augmented surveys");
    await user.click(screen.getByRole("button", { name: "Run search" }));

    expect(screen.getByText("Retrieval Augmented Surveys")).toBeTruthy();
    expect(screen.getAllByText("Retrieval Augmented Surveys: New Candidate from arXiv + Crossref").length).toBeGreaterThan(0);
    expect(screen.getByText("Metadata has been saved locally. The Agent has queued this paper for abstract screening before PDF download.")).toBeTruthy();
  });
});
