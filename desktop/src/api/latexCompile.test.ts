// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./transport";
import { latexCompile } from "./tauri";

vi.mock("./transport", async (original) => ({
  ...await original<typeof import("./transport")>(), invoke: vi.fn(),
}));
vi.mock("./browserPreview", async (original) => ({
  ...await original<typeof import("./browserPreview")>(), isFilePreviewMode: () => false,
}));

beforeEach(() => { vi.clearAllMocks(); });

describe("LaTeX compile time limit transport", () => {
  it("sends the chosen total budget to the native command", async () => {
    await latexCompile("main.tex", "main.pdf", true, "run-1", false, "xelatex", 1_800_000);
    expect(invoke).toHaveBeenCalledWith("latex_compile", {
      inputPath: "main.tex", outputPath: "main.pdf", cleanCache: true, runId: "run-1",
      continueOnError: false, engine: "xelatex", timeoutMs: 1_800_000,
    });
  });

  it("leaves the timeout unset to preserve the compiler default and environment override", async () => {
    await latexCompile("main.tex");
    expect(invoke).toHaveBeenCalledWith("latex_compile", expect.objectContaining({ timeoutMs: null }));
  });
});
