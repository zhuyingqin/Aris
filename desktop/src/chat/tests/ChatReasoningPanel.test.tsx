// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatReasoningPanel from "../ChatReasoningPanel";

const GPT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const THREE_LEVELS = ["low", "medium", "high"] as const;

function expectSingleSave(onChange: unknown, effort: string) {
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith(effort);
}

function pendingSave() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("ChatReasoningPanel", () => {
  it.each(GPT_LEVELS.map((level, index) => [level, index] as const))(
    "commits GPT slider position %s as the backend's exact effort value",
    async (level, index) => {
      const onChange = vi.fn();
      render(<ChatReasoningPanel language="en" effort={level === "high" ? "low" : "high"} levels={GPT_LEVELS} onChange={onChange} />);

      const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;
      expect(screen.getByRole("dialog", { name: "Reasoning effort" })).toBeTruthy();
      expect(slider.min).toBe("0");
      expect(slider.max).toBe("5");
      expect(slider.step).toBe("1");
      fireEvent.change(slider, { target: { value: String(index) } });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(slider);

      await waitFor(() => expectSingleSave(onChange, level));
    },
  );

  it.each(THREE_LEVELS.map((level, index) => [level, index] as const))(
    "maps a three-tier model position to %s without exposing extra GPT tiers",
    async (level, index) => {
      const onChange = vi.fn();
      render(<ChatReasoningPanel language="cn" effort={level === "high" ? "low" : "high"} levels={THREE_LEVELS} onChange={onChange} />);

      const slider = screen.getByRole("slider", { name: "思考强度" }) as HTMLInputElement;
      expect(screen.getByRole("dialog", { name: "思考强度" })).toBeTruthy();
      expect(slider.max).toBe("2");
      fireEvent.change(slider, { target: { value: String(index) } });
      fireEvent.pointerUp(slider);

      await waitFor(() => expectSingleSave(onChange, level));
    },
  );

  it("previews a drag and saves only its final position despite release and blur", async () => {
    const save = pendingSave();
    const onChange = vi.fn(() => save.promise);
    render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.change(slider, { target: { value: "5" } });
    expect(slider.value).toBe("5");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    fireEvent.pointerUp(slider);
    fireEvent.blur(slider);

    expectSingleSave(onChange, "max");
    expect(slider.disabled).toBe(true);
    await act(async () => save.resolve());
    await waitFor(() => expect(slider.disabled).toBe(false));
    fireEvent.blur(slider);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it.each([
    ["ArrowRight", "4", "xhigh"],
    ["ArrowLeft", "2", "medium"],
    ["Home", "0", "none"],
    ["End", "5", "max"],
  ])("commits keyboard adjustment on %s release", async (key, index, level) => {
    const onChange = vi.fn();
    render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    fireEvent.change(slider, { target: { value: index } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key });
    fireEvent.blur(slider);

    await waitFor(() => expectSingleSave(onChange, level));
  });

  it("commits an unfinished adjustment on blur", async () => {
    const onChange = vi.fn();
    render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.blur(slider);

    await waitFor(() => expectSingleSave(onChange, "medium"));
  });

  it.each([
    ["en", "Reset to default (High)"],
    ["cn", "恢复默认强度（高）"],
  ] as const)("resets to the actual high default in %s", async (language, label) => {
    const onChange = vi.fn();
    render(<ChatReasoningPanel language={language} effort="max" levels={GPT_LEVELS} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expectSingleSave(onChange, "high"));
  });

  it("omits reset if the backend does not offer high", () => {
    render(<ChatReasoningPanel language="en" effort="low" levels={["none", "low"]} onChange={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Reset to default (High)" })).toBeNull();
  });

  it("uses the parent's applied effort when asynchronous saving completes", async () => {
    const save = pendingSave();
    const onChange = vi.fn(() => save.promise);
    const view = render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "5" } });
    fireEvent.pointerUp(slider);
    expect(slider.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset to default (High)" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ChatReasoningPanel language="en" effort="max" levels={GPT_LEVELS} onChange={onChange} />);
    await act(async () => save.resolve());

    await waitFor(() => expect(slider.disabled).toBe(false));
    expect(slider.value).toBe("5");
    expectSingleSave(onChange, "max");
  });

  it("restores the old applied effort after saving fails", async () => {
    const save = pendingSave();
    const onChange = vi.fn(() => save.promise);
    render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "5" } });
    fireEvent.pointerUp(slider);
    expect(slider.disabled).toBe(true);
    await act(async () => save.reject(new Error("Could not save effort")));

    await waitFor(() => expect(slider.disabled).toBe(false));
    expect(slider.value).toBe("3");
    fireEvent.blur(slider);
    expectSingleSave(onChange, "max");
  });

  it("keeps the parent's effort authoritative when a callback does not update it", async () => {
    render(<ChatReasoningPanel language="en" effort="high" levels={GPT_LEVELS} onChange={vi.fn()} />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "5" } });
    fireEvent.pointerUp(slider);

    await waitFor(() => expect(slider.value).toBe("3"));
  });

  it("does not submit controls while explicitly disabled", () => {
    const onChange = vi.fn();
    render(<ChatReasoningPanel language="en" effort="max" levels={GPT_LEVELS} disabled onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;

    expect(slider.disabled).toBe(true);
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider, { key: "ArrowLeft" });
    fireEvent.blur(slider);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default (High)" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables a single-tier slider without inventing another level", () => {
    const onChange = vi.fn();
    render(<ChatReasoningPanel language="en" effort="high" levels={["high"]} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" }) as HTMLInputElement;

    expect(slider.disabled).toBe(true);
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider, { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default (High)" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Switch model: gpt-6.1-sol"],
    ["cn", "切换模型：gpt-6.1-sol"],
  ] as const)("opens the existing model picker from the model row in %s", (language, label) => {
    const onOpenModel = vi.fn();
    render(<ChatReasoningPanel language={language} effort="high" levels={GPT_LEVELS} modelName="gpt-6.1-sol" onChange={vi.fn()} onOpenModel={onOpenModel} />);

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onOpenModel).toHaveBeenCalledOnce();
  });
});
