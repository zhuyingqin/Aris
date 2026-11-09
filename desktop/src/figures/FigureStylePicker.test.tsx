// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FigureStylePicker from "./FigureStylePicker";
import { DEFAULT_STYLE_SPEC, compileFigureStyle, parseFigureStyle } from "./figureStyles";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(cleanup);

function Harness({ initial = compileFigureStyle(DEFAULT_STYLE_SPEC), changed = (_value: string) => {} }) {
  const [value, setValue] = useState(initial);
  return <FigureStylePicker language="cn" value={value} onChange={(next) => { changed(next); setValue(next); }} />;
}

describe("scientific style selection", () => {
  it("retains independent options when selecting by keyboard and from the gallery", () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    fireEvent.change(screen.getByLabelText("布局"), { target: { value: "vertical" } });
    fireEvent.change(screen.getByLabelText("配色"), { target: { value: "mono" } });
    fireEvent.change(screen.getByLabelText("间距"), { target: { value: "compact" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /印刷适配/ }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "技术框图" }), { key: "ArrowRight" });
    expect(parseFigureStyle(changed.mock.calls.at(-1)![0])).toEqual({ family: "theory", layout: "vertical", palette: "mono", density: "compact", print: true });
    expect(screen.getByRole("radio", { name: "抽象关系图" }).getAttribute("aria-checked")).toBe("true");
    const compare = screen.getByRole("button", { name: "学科示例" }); compare.focus(); fireEvent.click(compare);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "使用此风格" })[3]);
    expect(parseFigureStyle(changed.mock.calls.at(-1)![0])).toEqual({ family: "tensors", layout: "vertical", palette: "mono", density: "compact", print: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(compare);
  });
  it("leaves custom style text untouched until a family is explicitly selected", () => {
    const changed = vi.fn();
    render(<Harness initial="custom historical style" changed={changed} />);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByLabelText("配色").matches(":disabled")).toBe(true);
    expect(screen.getAllByRole("radio").every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "图标叙事" }));
    expect(parseFigureStyle(changed.mock.calls[0][0])?.family).toBe("narrative");
    expect(screen.getByLabelText("配色").matches(":disabled")).toBe(false);
  });
  it("allows browsing examples while protecting an uploaded source from restyling", () => {
    const changed = vi.fn();
    render(<FigureStylePicker language="cn" preserveSource value={compileFigureStyle(DEFAULT_STYLE_SPEC)} onChange={changed} />);
    expect(screen.getAllByRole("radio").every((radio) => radio.matches(":disabled"))).toBe(true);
    expect(screen.getByLabelText("布局").matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "学科示例" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: "使用此风格" }).every((button) => button.matches(":disabled"))).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });
  it("opens complex scene detail without selecting or inserting it and restores gallery focus", () => {
    const changed = vi.fn(), load = vi.fn();
    render(<FigureStylePicker language="cn" value={compileFigureStyle(DEFAULT_STYLE_SPEC)} onChange={changed} onUseScenario={load} />);
    fireEvent.click(screen.getByRole("button", { name: "学科示例" }));
    fireEvent.click(screen.getByRole("button", { name: "查看Transformer 编码器细节" }));
    expect(screen.getByRole("dialog", { name: "Transformer 编码器" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Transformer 编码器" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Attention Is All You Need/ }).getAttribute("href")).toBe("https://arxiv.org/abs/1706.03762");
    expect(changed).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.getByRole("dialog", { name: "学科场景示例" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看Transformer 编码器细节" }));
  });
  it("labels description replacement explicitly and protects imports from scene insertion", () => {
    const load = vi.fn();
    const view = render(<FigureStylePicker language="cn" hasDescription value={compileFigureStyle(DEFAULT_STYLE_SPEC)} onChange={vi.fn()} onUseScenario={load} />);
    fireEvent.click(screen.getByRole("button", { name: "学科示例" }));
    expect(screen.queryByRole("button", { name: "载入场景示例" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "替换描述并载入场景" })[5]);
    expect(load.mock.calls[0][0]).toMatchObject({ id: "mapk", family: "illustration" });
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<FigureStylePicker language="cn" preserveSource value={compileFigureStyle(DEFAULT_STYLE_SPEC)} onChange={vi.fn()} onUseScenario={load} />);
    fireEvent.click(screen.getByRole("button", { name: "学科示例" }));
    expect(screen.getAllByRole("button", { name: "载入场景示例" }).every((button) => button.matches(":disabled"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "查看EGFR–MAPK 信号通路细节" }));
    expect(screen.getByRole("button", { name: "载入场景示例" }).matches(":disabled")).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
