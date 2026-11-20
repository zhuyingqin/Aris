import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PDF reader is a core viewer: Chat's side panel opens it whether or not
// the Literature plugin is on. Nothing under pdf/ may reach into literature/.
const dir = new URL("../", import.meta.url);
const sources = readdirSync(dir).filter((name) => /\.(ts|tsx|css)$/.test(name));

describe("pdf module boundary", () => {
  it("has sources to check", () => {
    expect(sources).toContain("PdfReader.tsx");
  });

  it.each(sources)("%s imports nothing from literature/", (name) => {
    const text = readFileSync(new URL(name, dir), "utf8");
    expect(text).not.toMatch(/["']\.\.\/literature\//);
  });
});
