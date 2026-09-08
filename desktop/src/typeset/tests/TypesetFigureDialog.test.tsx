// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TypesetFigureDialog from "../TypesetFigureDialog";
import { figureSnippet, type FigureDraft } from "../latexFigure";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "en", languagePreferenceSet: true });
});

afterEach(cleanup);

const IMAGES = ["figures/wake.pdf", "figures/spectrum.png", "chapters/ch2.tex", "refs.bib"];

describe("TypesetFigureDialog", () => {
  it("lists only the project's images and filters them", () => {
    render(<TypesetFigureDialog open initial={null} imagePaths={IMAGES} onCancel={() => {}} onConfirm={() => {}} />);

    const listbox = () => within(screen.getByRole("listbox"));
    const options = listbox().getAllByRole("option").map((option) => option.textContent);
    // A .tex or .bib is not something \includegraphics can take.
    expect(options).toEqual(["figures/wake.pdf", "figures/spectrum.png"]);

    fireEvent.change(screen.getByLabelText("Filter project images"), { target: { value: "spec" } });
    expect(listbox().getAllByRole("option").map((option) => option.textContent)).toEqual(["figures/spectrum.png"]);
  });

  it("suggests a label from the chosen file until the user types their own", () => {
    render(<TypesetFigureDialog open initial={null} imagePaths={IMAGES} onCancel={() => {}} onConfirm={() => {}} />);
    const label = screen.getByLabelText("Label") as HTMLInputElement;
    expect(label.value).toBe("");

    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "figures/wake.pdf" }));
    expect(label.value).toBe("fig:wake");

    fireEvent.change(label, { target: { value: "fig:mine" } });
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "figures/spectrum.png" }));
    // A label the user typed is theirs; picking another file must not clobber it.
    expect(label.value).toBe("fig:mine");
  });

  it("hands back a draft that renders the expected float, and survives unmounting on submit", () => {
    const onConfirm = vi.fn<(draft: FigureDraft) => void>();
    const { unmount } = render(
      <TypesetFigureDialog open initial={null} imagePaths={IMAGES} onCancel={() => {}} onConfirm={onConfirm} />,
    );

    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "figures/wake.pdf" }));
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Wake sector" } });
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(figureSnippet(onConfirm.mock.calls[0][0])).toBe([
      "\\begin{figure}[htbp]",
      "\\centering",
      "\\includegraphics[width=0.5\\linewidth]{figures/wake.pdf}",
      "\\caption{Wake sector}",
      "\\label{fig:wake}",
      "\\end{figure}",
    ].join("\n"));

    // The host closes the dialog from inside this handler, so unmounting right
    // after a controlled input changed must not throw.
    expect(() => unmount()).not.toThrow();
  });

  it("refuses to insert without a path, and opens pre-filled when editing", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <TypesetFigureDialog open initial={null} imagePaths={IMAGES} onCancel={() => {}} onConfirm={onConfirm} />,
    );
    expect((screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <TypesetFigureDialog
        open
        initial={{ path: "figures/spectrum.png", widthFraction: 0.25, label: "fig:kept" }}
        imagePaths={IMAGES}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect((screen.getByLabelText("Image file") as HTMLInputElement).value).toBe("figures/spectrum.png");
    expect((screen.getByLabelText("Width") as HTMLSelectElement).value).toBe("0.25");
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("fig:kept");
  });
});
