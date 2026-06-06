import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  it("parses quoted prompt arguments", () => {
    expect(parseCliArgs('aris --output-format json prompt "hello world"')).toEqual([
      "--output-format",
      "json",
      "prompt",
      "hello world",
    ]);
  });

  it("keeps unquoted Windows paths intact", () => {
    expect(parseCliArgs("--resume C:\\Users\\wt\\session.json /status")).toEqual([
      "--resume",
      "C:\\Users\\wt\\session.json",
      "/status",
    ]);
  });

  it("reports unclosed quotes", () => {
    expect(() => parseCliArgs('prompt "unfinished')).toThrow("Unclosed");
  });
});
