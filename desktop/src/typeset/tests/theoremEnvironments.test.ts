import { describe, expect, it } from "vitest";
import {
  assignTheoremNumbers,
  theoremDefinitions,
  type TheoremDefinition,
} from "../theoremEnvironments";

describe("theoremDefinitions", () => {
  it("reads every amsthm spelling, including the optional groups", () => {
    const preamble = [
      "\\newtheorem{requirement}{Requirement}",
      "\\newtheorem{thm}{Theorem}[section]",
      "\\newtheorem{lem}[thm]{Lemma}",
      "\\newtheorem*{remark}{Remark}",
    ].join("\n");

    expect([...theoremDefinitions(preamble).values()]).toEqual<TheoremDefinition[]>([
      { environment: "requirement", heading: "Requirement", counter: "requirement", within: null },
      { environment: "thm", heading: "Theorem", counter: "thm", within: "section" },
      { environment: "lem", heading: "Lemma", counter: "thm", within: null },
      { environment: "remark", heading: "Remark", counter: null, within: null },
    ]);
  });

  it("is not fooled by \\newtheoremstyle, which declares no environment", () => {
    const preamble = "\\newtheoremstyle{plain}{3pt}{3pt}{\\itshape}{}{\\bfseries}{.}{.5em}{}";
    expect([...theoremDefinitions(preamble).keys()]).toEqual([]);
  });

  it("reads thmtools \\declaretheorem, including its shared-counter keys", () => {
    const preamble = [
      "\\declaretheorem[name=Requirement,numberwithin=section]{requirement}",
      "\\declaretheorem[sibling=requirement,name=Assumption]{assumption}",
      "\\declaretheorem[name=Notation,numbered=no]{notation}",
      "\\declaretheorem{observation}",
    ].join("\n");

    expect([...theoremDefinitions(preamble).values()]).toEqual<TheoremDefinition[]>([
      { environment: "requirement", heading: "Requirement", counter: "requirement", within: "section" },
      { environment: "assumption", heading: "Assumption", counter: "requirement", within: null },
      { environment: "notation", heading: "Notation", counter: null, within: null },
      { environment: "observation", heading: "Observation", counter: "observation", within: null },
    ]);
  });

  it("declares several environments from one \\declaretheorem list", () => {
    const definitions = theoremDefinitions("\\declaretheorem[style=plain]{lemma,corollary}");
    expect([...definitions.keys()]).toEqual(["lemma", "corollary"]);
    expect(definitions.get("corollary")?.heading).toBe("Corollary");
  });

  it("skips a declaration the caller reports as commented out", () => {
    const preamble = "% \\newtheorem{ghost}{Ghost}\n\\newtheorem{real}{Real}";
    const commented = preamble.indexOf("\\newtheorem{ghost}");
    const definitions = theoremDefinitions(preamble, (position) => position === commented);
    expect([...definitions.keys()]).toEqual(["real"]);
  });

  it("lets a later declaration of the same name win, as LaTeX's would", () => {
    const definitions = theoremDefinitions("\\newtheorem{req}{Req}\n\\newtheorem{req}{Requirement}");
    expect(definitions.get("req")?.heading).toBe("Requirement");
  });
});

describe("assignTheoremNumbers", () => {
  const definitions = theoremDefinitions([
    "\\newtheorem{thm}{Theorem}[section]",
    "\\newtheorem{lem}[thm]{Lemma}",
    "\\newtheorem{req}{Requirement}",
    "\\newtheorem*{remark}{Remark}",
  ].join("\n"));

  it("restarts a counter with its owner's sectioning counter and shares siblings", () => {
    const sections: Record<number, string> = { 100: "1", 200: "1", 300: "2" };
    const numbers = assignTheoremNumbers(
      [
        { environment: "thm", from: 100 },
        { environment: "lem", from: 200 },
        { environment: "thm", from: 300 },
      ],
      definitions,
      (counter, from) => (counter === "section" ? sections[from] ?? null : null),
    );

    // `lem` borrows `thm`'s counter, so it continues that run rather than
    // starting one of its own — and both restart when the section does.
    expect([...numbers.values()]).toEqual(["1.1", "1.2", "2.1"]);
  });

  it("numbers a counter with no sectioning parent straight through", () => {
    const numbers = assignTheoremNumbers(
      [
        { environment: "req", from: 10 },
        { environment: "req", from: 20 },
        { environment: "req", from: 30 },
      ],
      definitions,
      () => "3",
    );
    expect([...numbers.values()]).toEqual(["1", "2", "3"]);
  });

  it("omits starred and undeclared environments rather than guessing", () => {
    const numbers = assignTheoremNumbers(
      [
        { environment: "remark", from: 10 },
        { environment: "definition", from: 20 },
      ],
      definitions,
      () => null,
    );
    expect(numbers.size).toBe(0);
  });
});
