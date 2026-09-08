import { describe, expect, it } from "vitest";
import {
  SYMBOL_GROUPS,
  filterSymbols,
  symbolInsertion,
  symbolSelectionRange,
} from "../symbolPalette";

describe("symbol palette data", () => {
  it("has no duplicate commands, so React keys and the grid stay stable", () => {
    const commands = SYMBOL_GROUPS.flatMap((group) => group.symbols.map((symbol) => symbol.command));
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("filters on the command and on its keywords", () => {
    const byCommand = filterSymbols(SYMBOL_GROUPS, "alpha");
    expect(byCommand.flatMap((group) => group.symbols).map((symbol) => symbol.command)).toContain("\\alpha");

    // "sum" is the keyword on \sum; searching the concept has to find it.
    const byKeyword = filterSymbols(SYMBOL_GROUPS, "integral");
    expect(byKeyword.flatMap((group) => group.symbols).map((symbol) => symbol.command)).toContain("\\int");

    // Empty groups are dropped rather than rendered as bare headings.
    expect(filterSymbols(SYMBOL_GROUPS, "zzzz")).toEqual([]);
    expect(filterSymbols(SYMBOL_GROUPS, "   ")).toHaveLength(SYMBOL_GROUPS.length);
  });
});

describe("symbolInsertion", () => {
  it("brings math delimiters into prose but never inside an existing formula", () => {
    const alpha = SYMBOL_GROUPS[0].symbols[0];
    expect(symbolInsertion(alpha, false)).toBe("$\\alpha$");
    // Inside `$…$` the extra dollars would close the formula early.
    expect(symbolInsertion(alpha, true)).toBe("\\alpha");
  });

  it("leaves non-math escapes alone in both contexts", () => {
    const percent = SYMBOL_GROUPS.flatMap((group) => group.symbols).find((symbol) => symbol.command === "\\%");
    expect(percent).toBeTruthy();
    expect(symbolInsertion(percent!, false)).toBe("\\%");
    expect(symbolInsertion(percent!, true)).toBe("\\%");
  });
});

describe("symbolSelectionRange", () => {
  it("selects a template's first placeholder so the next keystroke replaces it", () => {
    const [from, to] = symbolSelectionRange("\\frac{a}{b}");
    expect("\\frac{a}{b}".slice(from, to)).toBe("a");
  });

  it("puts the caret inside a delimiter pair", () => {
    const text = "\\left( \\right)";
    const [from, to] = symbolSelectionRange(text);
    expect(from).toBe(to);
    expect(text.slice(0, from)).toBe("\\left( ");
  });

  it("puts the caret after a plain symbol", () => {
    expect(symbolSelectionRange("\\alpha")).toEqual(["\\alpha".length, "\\alpha".length]);
  });
});
