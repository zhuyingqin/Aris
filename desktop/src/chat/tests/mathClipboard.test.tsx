// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMathClipboard } from "../../math/mathClipboard";
import { htmlClipboardToLatex } from "../../typeset/latexHtmlPaste";
import PaperReadingContent from "../../literature/PaperReadingContent";
import MathText from "../../literature/MathText";
import MarkdownContent from "../MarkdownContent";

vi.mock("../../api/tauri", () => ({ isTauri: () => false }));

let uninstall: () => void;
beforeEach(() => { uninstall = installMathClipboard(); });
afterEach(() => {
  uninstall();
  document.getSelection()?.removeAllRanges();
  cleanup();
});

function select(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  return range;
}

function copy(target: Node = document) {
  const data = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (type: string, text: string) => data.set(type, text) },
  });
  target.dispatchEvent(event);
  return { data, event };
}

describe("rendered formula copying", () => {
  it("copies the entire inline formula when only a rendered glyph is selected, without moving the selection", () => {
    const { container } = render(<MarkdownContent text={String.raw`结果 $\rho^{+}(x)\approx 0$。`} />);
    const glyph = container.querySelector(".katex-html .mord")!.firstChild!;
    const range = select(glyph);
    const start = range.startContainer;
    const end = range.endContainer;
    const { data, event } = copy(glyph);

    expect(event.defaultPrevented).toBe(true);
    expect(data.get("text/plain")).toBe(String.raw`$\rho^{+}(x)\approx 0$`);
    expect(data.get("text/html")).toBe(String.raw`<span data-somniq-math="inline">$\rho^{+}(x)\approx 0$</span>`);
    expect(htmlClipboardToLatex(data.get("text/html")!)).toBe(data.get("text/plain"));
    expect(range.startContainer).toBe(start);
    expect(range.endContainer).toBe(end);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("keeps display delimiters when selection begins inside a display formula", () => {
    const source = String.raw`\tilde Q_\theta(x,u)=\max_{w\in W_N} Q_\theta(x,u,w)`;
    const { container } = render(<MarkdownContent text={`\\[${source}\\]`} />);
    select(container.querySelector(".katex-html .mord")!);
    const { data } = copy();
    expect(data.get("text/plain")).toBe(`$$\n${source}\n$$`);
    expect(data.get("text/html")).not.toContain("katex-html");
    expect(htmlClipboardToLatex(data.get("text/html")!)).toBe(data.get("text/plain"));
  });

  it("preserves prose and both inline and display formulas across paragraphs", () => {
    const { container } = render(<MarkdownContent text={String.raw`其中 $V_\theta(x)$ 是值。

$$\rho^-(x)=\left|V_\theta(x)-Q_\theta(x,w)\right|$$

若 $\rho^+\approx 0$，继续。`} />);
    select(container.querySelector(".md-content")!);
    const { data } = copy();
    expect(data.get("text/plain")).toBe("其中 $V_\\theta(x)$ 是值。\n\n$$\n\\rho^-(x)=\\left|V_\\theta(x)-Q_\\theta(x,w)\\right|\n$$\n\n若 $\\rho^+\\approx 0$，继续。");
    expect(data.get("text/html")).toContain('<p>其中 <span data-somniq-math="inline">$V_\\theta(x)$</span> 是值。</p>');
    expect(htmlClipboardToLatex(data.get("text/html")!)).toBe(data.get("text/plain"));
    expect(data.get("text/plain")).not.toContain("ρ");
  });

  it("keeps table columns and rows when copying multiple formulas", () => {
    const { container } = render(<MarkdownContent text={String.raw`| 方法 | 结果 |
|---|---|
| up | $\rho^+\approx 0$ |
| sp | $\rho^-\approx\Delta_V$ |`} />);
    select(container.querySelector("table")!);
    const { data } = copy();
    expect(data.get("text/plain")).toBe("方法\t结果\nup\t$\\rho^+\\approx 0$\nsp\t$\\rho^-\\approx\\Delta_V$");
    expect(data.get("text/html")).toContain('<td><span data-somniq-math="inline">$\\rho^-\\approx\\Delta_V$</span></td>');
    const pasted = htmlClipboardToLatex(data.get("text/html")!);
    expect(pasted).toContain(String.raw`up & $\rho^+\approx 0$`);
    expect(pasted).toContain(String.raw`sp & $\rho^-\approx\Delta_V$`);
  });

  it("keeps empty cells at the edges of copied tables", () => {
    const { container } = render(<MarkdownContent text={"| | Result | |\n|---|---|---|\n| | $x^2$ | |"} />);
    select(container.querySelector("table")!);
    expect(copy().data.get("text/plain")).toBe("\tResult\t\n\t$x^2$\t");
  });

  it("preserves only the selected prose around formula boundaries", () => {
    const { container } = render(<MarkdownContent text={String.raw`前文 $\alpha$，中间 $\beta$，后文。`} />);
    const paragraph = container.querySelector("p")!;
    const range = select(paragraph);
    range.setStart(paragraph.firstChild!, 1);
    range.setEnd(paragraph.lastChild!, 2);
    const { data } = copy();
    expect(data.get("text/plain")).toBe(String.raw`文 $\alpha$，中间 $\beta$，后`);
  });

  it("expands formulas at both selection boundaries", () => {
    const { container } = render(<MarkdownContent text={String.raw`前 $\alpha^2$ 到 $\beta^3$ 后`} />);
    const glyphs = container.querySelectorAll(".katex-html");
    const range = select(container);
    range.setStart(glyphs[0].querySelector(".mord")!.firstChild!, 0);
    range.setEnd(glyphs[1].querySelector(".mord")!.firstChild!, 1);
    expect(copy().data.get("text/plain")).toBe(String.raw`$\alpha^2$ 到 $\beta^3$`);
  });

  it("keeps LaTeX characters as text in the rich clipboard payload", () => {
    const { container } = render(<MarkdownContent text={String.raw`$a < b \quad \text{a\&b}$`} />);
    select(container.querySelector(".katex")!);
    const { data } = copy();
    expect(data.get("text/plain")).toBe(String.raw`$a < b \quad \text{a\&b}$`);
    const html = new DOMParser().parseFromString(data.get("text/html")!, "text/html");
    expect(html.body.textContent).toBe(data.get("text/plain"));
    expect(html.querySelector("b")).toBeNull();
  });

  it("keeps list breaks and literal code whitespace without copying toolbars or line numbers", () => {
    const { container } = render(<MarkdownContent text={"- $x^2$\n- second\n\n```tex\n  \\alpha\n\n  \\beta\n```"} />);
    select(container.querySelector(".md-content")!);
    const text = copy().data.get("text/plain")!;
    expect(text).toContain("$x^2$\nsecond\n");
    expect(text).toContain("  \\alpha\n\n  \\beta");
    expect(text).not.toContain("Copy");
    expect(text).not.toMatch(/\n[123]\n/);
  });

  it.each(["paper reading", "literature math"])("also copies LaTeX in %s", (surface) => {
    const { container } = render(surface === "paper reading"
      ? <PaperReadingContent content={String.raw`值 $\hat v(x)$。`} />
      : <MathText text={String.raw`值 $\hat v(x)$。`} />);
    select(container.querySelector(".katex")!);
    expect(copy().data.get("text/plain")).toBe(String.raw`$\hat v(x)$`);
  });

  it("leaves ordinary prose and code copying to the browser", () => {
    const { container } = render(<MarkdownContent text={"ordinary prose\n\n```tex\n$\\alpha$\n```"} />);
    select(container);
    const { event, data } = copy();
    expect(event.defaultPrevented).toBe(false);
    expect(data.size).toBe(0);
  });

  it("leaves empty selections and unavailable clipboard data alone", () => {
    const { container } = render(<MarkdownContent text="$x$" />);
    expect(copy().event.defaultPrevented).toBe(false);
    const range = select(container);
    range.collapse(true);
    expect(copy().event.defaultPrevented).toBe(false);
    select(container);
    const event = new Event("copy", { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("respects copy handlers that already handled the event", () => {
    const { container } = render(<MarkdownContent text="$x$" />);
    select(container);
    const handled = (event: Event) => event.preventDefault();
    container.addEventListener("copy", handled);
    expect(copy(container).data.size).toBe(0);
  });

  it("does not overwrite text input copying with an old document selection", () => {
    const { container } = render(<><MarkdownContent text="$x$" /><textarea defaultValue="source text" /></>);
    select(container.querySelector(".katex")!);
    const input = container.querySelector("textarea")!;
    fireEvent.focus(input);
    expect(copy(input).data.size).toBe(0);
  });

  it("leaves formula selections inside editable content to the editor", () => {
    const { container } = render(<div contentEditable suppressContentEditableWarning><MathText text="$x^2$" /></div>);
    select(container.querySelector(".katex")!);
    expect(copy().data.size).toBe(0);
  });

  it("unregisters the document copy handler", () => {
    const { container } = render(<MarkdownContent text="$x$" />);
    select(container);
    uninstall();
    expect(copy().event.defaultPrevented).toBe(false);
  });
});
