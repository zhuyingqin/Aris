import { describe, expect, it } from "vitest";
import {
  pdfTextRunBox,
  refineSourceColumn,
  remapCompiledLine,
  runTextRatio,
  syncTexPointFromPageOffset,
  wordAtRatio,
} from "../syncTexMapping";

/**
 * The fixture numbers come from a real TeX Live 2025 build of a one-inch-margin
 * `article`: `pdflatex -synctex=1`, then `synctex view -i 5:0:main.tex`, which
 * reports the first body line as `x:98.290358 y:103.783554 h:71.999985
 * v:105.720734 W:468 H:8.855677`. pdf.js reads the same run back as
 * `transform:[9.9626,0,0,9.9626,72,688.216]` with `ascent:0.694
 * descent:-0.194`, on a 612x792 page.
 */
const CM_STYLE = { ascent: 0.694, descent: -0.194 };
const ALPHA_ITEM = {
  transform: [9.9626, 0, 0, 9.9626, 72, 688.216],
  width: 467.99712,
  height: 9.9626,
  fontName: "g_d0_f2",
};

/** `PageViewport` for a 612x792 page at `scale`, rotation 0. */
function viewportAt(scale: number) {
  return {
    transform: [scale, 0, 0, -scale, 0, 792 * scale],
    convertToPdfPoint: (x: number, y: number) => [x / scale, (792 * scale - y) / scale],
  };
}

describe("syncTexPointFromPageOffset", () => {
  it("maps a click to big points measured from the page top-left", () => {
    const viewport = viewportAt(1.25);
    // The baseline of the first body line sits at 688.216 in PDF user space,
    // which is 792 - 688.216 = 103.784 from the top — SyncTeX's `y`.
    const point = syncTexPointFromPageOffset(viewport, [0, 0, 612, 792], 90, (792 - 688.216) * 1.25);
    expect(point.x).toBeCloseTo(72, 6);
    expect(point.y).toBeCloseTo(103.784, 3);
  });

  it("subtracts the page box origin so a cropped page is not shifted", () => {
    const viewport = viewportAt(1);
    const uncropped = syncTexPointFromPageOffset(viewport, [0, 0, 612, 792], 100, 200);
    const cropped = syncTexPointFromPageOffset(viewport, [20, 30, 592, 762], 100, 200);
    expect(uncropped.x - cropped.x).toBeCloseTo(20, 6);
    expect(uncropped.y - cropped.y).toBeCloseTo(30, 6);
  });
});

describe("pdfTextRunBox", () => {
  it("reproduces the box SyncTeX recorded for the same line", () => {
    const box = pdfTextRunBox(ALPHA_ITEM, CM_STYLE, viewportAt(1).transform, 1, 12);
    // SyncTeX: v:105.720734 is the box bottom, H:8.855677 its total height.
    // pdf.js rounds the declared metrics to three decimals, so the agreement
    // bottoms out just under 0.01bp — a hundredth of a point of a 12bp line.
    expect(box).not.toBeNull();
    expect(box!.left).toBeCloseTo(72, 3);
    expect(Math.abs(box!.height - 8.855677)).toBeLessThan(0.01);
    expect(Math.abs(box!.top + box!.height - 105.720734)).toBeLessThan(0.01);
  });

  it("keeps the box on the ink rather than on the em square", () => {
    const box = pdfTextRunBox(ALPHA_ITEM, CM_STYLE, viewportAt(1).transform, 1, 12)!;
    const baseline = 792 - ALPHA_ITEM.transform[5];
    // Sizing off `item.height` (9.9626) from the baseline upwards would put the
    // top 3bp above the ink, inside the previous line's SyncTeX box.
    expect(baseline - box.top).toBeLessThan(ALPHA_ITEM.height);
    expect(box.top + box.height).toBeGreaterThan(baseline);
  });

  it("scales with zoom and falls back when a font ships no metrics", () => {
    const zoomed = pdfTextRunBox(ALPHA_ITEM, CM_STYLE, viewportAt(2).transform, 2, 12)!;
    const plain = pdfTextRunBox(ALPHA_ITEM, CM_STYLE, viewportAt(1).transform, 1, 12)!;
    expect(zoomed.height).toBeCloseTo(plain.height * 2, 3);
    expect(zoomed.width).toBeCloseTo(plain.width * 2, 3);

    const bare = pdfTextRunBox(ALPHA_ITEM, undefined, viewportAt(1).transform, 1, 12)!;
    expect(bare.height).toBeCloseTo(9.9626, 3);
    expect(bare.top + bare.height).toBeGreaterThan(792 - ALPHA_ITEM.transform[5]);
  });

  it("rejects an item with no usable transform", () => {
    expect(pdfTextRunBox({ transform: [1, 2] }, CM_STYLE, viewportAt(1).transform, 1, 4)).toBeNull();
    expect(pdfTextRunBox({}, CM_STYLE, viewportAt(1).transform, 1, 4)).toBeNull();
  });
});

describe("wordAtRatio", () => {
  const text = "Alpha beta gamma delta";

  it("picks the word under the click", () => {
    expect(wordAtRatio(text, 0)).toBe("Alpha");
    expect(wordAtRatio(text, 8 / text.length)).toBe("beta");
    expect(wordAtRatio(text, 1)).toBe("delta");
  });

  it("snaps to the nearer word when the click lands between words", () => {
    expect(wordAtRatio("Alpha    beta", 6 / 13)).toBe("Alpha");
    expect(wordAtRatio("Alpha    beta", 8 / 13)).toBe("beta");
  });

  it("returns nothing when there is no word to pick", () => {
    expect(wordAtRatio("", 0.5)).toBe("");
    expect(wordAtRatio("+ = -", 0.5)).toBe("");
  });
});

describe("runTextRatio", () => {
  it("reports where in a run the click landed", () => {
    expect(runTextRatio({ left: 100, width: 200 }, 100)).toBe(0);
    expect(runTextRatio({ left: 100, width: 200 }, 200)).toBe(0.5);
    expect(runTextRatio({ left: 100, width: 200 }, 400)).toBe(1);
    expect(runTextRatio({ left: 100, width: 0 }, 400)).toBe(0);
  });
});

describe("refineSourceColumn", () => {
  it("locates the clicked word inside a paragraph written on one line", () => {
    const line = "The model achieves a lower error than the baseline model overall.";
    expect(refineSourceColumn(line, "baseline", 0.7)).toEqual({ column: 42, length: 8 });
  });

  it("uses the click position to choose between repeats", () => {
    const line = "model a and model b";
    expect(refineSourceColumn(line, "model", 0)?.column).toBe(0);
    expect(refineSourceColumn(line, "model", 1)?.column).toBe(12);
  });

  it("prefers a standalone word over one buried in a control sequence", () => {
    const line = "\\begin{itemize} in the list";
    expect(refineSourceColumn(line, "in", 0)?.column).toBe(16);
  });

  it("returns nothing when the word is absent", () => {
    expect(refineSourceColumn("nothing here", "absent")).toBeNull();
    expect(refineSourceColumn("", "word")).toBeNull();
    expect(refineSourceColumn("line", "")).toBeNull();
  });
});

describe("remapCompiledLine", () => {
  const compiled = ["one", "two", "three", "four", "five"].join("\n");

  it("is the identity when the buffer still matches the build", () => {
    expect(remapCompiledLine(compiled, compiled, 3)).toBe(3);
  });

  it("shifts a line down by the lines inserted above it", () => {
    const current = ["one", "inserted", "also inserted", "two", "three", "four", "five"].join("\n");
    expect(remapCompiledLine(compiled, current, 3)).toBe(5);
    expect(remapCompiledLine(compiled, current, 1)).toBe(1);
  });

  it("shifts a line up by the lines removed above it", () => {
    const current = ["one", "four", "five"].join("\n");
    expect(remapCompiledLine(compiled, current, 4)).toBe(2);
  });

  it("ignores edits that happen below the recorded line", () => {
    const current = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
    expect(remapCompiledLine(compiled, current, 2)).toBe(2);
  });

  it("follows a line that moved inside the edited region", () => {
    const current = ["one", "inserted", "two", "rewritten", "four", "five"].join("\n");
    expect(remapCompiledLine(compiled, current, 2)).toBe(3);
  });

  it("clamps into the edited region when the recorded line is gone", () => {
    const current = ["one", "rewritten", "five"].join("\n");
    const line = remapCompiledLine(compiled, current, 3);
    expect(line).toBeGreaterThanOrEqual(1);
    expect(line).toBeLessThanOrEqual(3);
  });

  it("survives an out-of-range line", () => {
    expect(remapCompiledLine(compiled, "one", 99)).toBeGreaterThanOrEqual(1);
  });
});
