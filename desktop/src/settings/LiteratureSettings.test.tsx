import { describe, expect, it } from "vitest";
import { previewAttachmentName } from "./LiteratureSettings";

const SAMPLE = {
  creator: "Sutton",
  year: "1998",
  title: "Reinforcement Learning An Introduction",
  citationKey: "sutton1998reinforcement",
  venue: "MIT Press",
  itemType: "book",
};

/**
 * The preview exists to tell the user what the backend will do, so it has to
 * agree with `runtime::render_attachment_stem` on the cases that surprise
 * people: a missing value drops its own separator, and path characters never
 * survive.
 */
describe("attachment name preview", () => {
  it("matches the Zotero-style default", () => {
    expect(previewAttachmentName("{creator} - {year} - {title}", SAMPLE))
      .toBe("Sutton - 1998 - Reinforcement Learning An Introduction");
  });

  it("drops the separator that belonged to an empty placeholder", () => {
    expect(previewAttachmentName("{creator} - {year} - {title}", { ...SAMPLE, year: "" }))
      .toBe("Sutton - Reinforcement Learning An Introduction");
    expect(previewAttachmentName("{creator} - {year} - {title}", { ...SAMPLE, creator: "", year: "" }))
      .toBe("Reinforcement Learning An Introduction");
  });

  it("never lets a template produce a path separator", () => {
    for (const template of ["../{title}", "{creator}/{title}", "{creator}\\{title}"]) {
      const preview = previewAttachmentName(template, SAMPLE);
      expect(preview).not.toContain("/");
      expect(preview).not.toContain("\\");
      expect(preview).not.toContain("..");
    }
  });

  it("returns nothing when no placeholder resolves", () => {
    expect(previewAttachmentName("{creator} - {year}", { creator: "", year: "" })).toBe("");
  });

  it("supports the other placeholders", () => {
    expect(previewAttachmentName("{citationKey}", SAMPLE)).toBe("sutton1998reinforcement");
    expect(previewAttachmentName("{venue} {year}", SAMPLE)).toBe("MIT Press 1998");
  });
});
