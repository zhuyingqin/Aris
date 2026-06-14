// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MathText from "./MathText";

afterEach(cleanup);

describe("MathText", () => {
  it("renders an undelimited Unicode equation as formatted math", () => {
    const { container } = render(<MathText text={"X\u0302_T(t)=M_T Z_T(t)"} />);

    const formula = container.querySelector('[role="math"][aria-label="X̂_T(t)=M_T Z_T(t)"]');
    expect(formula).toBeTruthy();
    if (!formula) throw new Error("formula was not rendered");
    expect(formula.className).toContain("display");
    expect(formula.querySelector(".katex")).toBeTruthy();
  });

  it("renders delimited LaTeX alongside prose", () => {
    const { container } = render(<MathText text="模型满足 $X_T=M_TZ_T$，并用于预测。" />);

    expect(container.querySelector('[role="math"][aria-label="X_T=M_TZ_T"]')).toBeTruthy();
    expect(screen.getByText(/模型满足/)).toBeTruthy();
  });

  it("renders an undelimited Unicode equation inside Chinese prose", () => {
    const { container } = render(<MathText text={"状态变换满足 X\u0302_T(t)=M_T Z_T(t)。"} />);

    expect(container.querySelector('[role="math"][aria-label="X̂_T(t)=M_T Z_T(t)"]')).toBeTruthy();
    expect(screen.getByText(/状态变换满足/)).toBeTruthy();
  });
});
