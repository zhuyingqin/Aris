// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  citationCreatorsForPaper,
  formatBibliography,
  formatCitation,
  importCslStyle,
  readCitationStyle,
  readCitationStyles,
  removeCslStyle,
  writeCitationStyle,
} from "../citationEngine";
import type { LiteraturePaper } from "../literatureTypes";

const paper = {
  id: "paper-1",
  title: "A local-first research workflow",
  authors: ["Legacy Author"],
  creators: [{
    id: "author-2",
    creatorType: "author",
    firstName: "Grace",
    lastName: "Hopper",
    fieldMode: "twoField",
    orderIndex: 1,
  }, {
    id: "editor-1",
    creatorType: "editor",
    name: "Editorial Board",
    fieldMode: "oneField",
    orderIndex: 2,
  }, {
    id: "author-1",
    creatorType: "author",
    firstName: "Ada",
    lastName: "Lovelace",
    fieldMode: "twoField",
    orderIndex: 0,
  }],
  year: 2024,
  venue: "Research Systems",
  volume: "12",
  issue: "2",
  pages: "34-45",
  doi: "10.1234/example",
} as LiteraturePaper;

describe("local CSL-style citation engine", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps author order and excludes non-author roles from citations", () => {
    expect(citationCreatorsForPaper(paper).map((creator) => creator.lastName)).toEqual([
      "Lovelace",
      "Hopper",
    ]);
    expect(formatCitation(paper, "apa7")).toBe("(Lovelace & Hopper, 2024)");
    expect(formatCitation(paper, "ieee", 3)).toBe("[3]");
  });

  it("renders distinct bibliography formats with DOI and publication fields", () => {
    const apa = formatBibliography(paper, "apa7");
    const ieee = formatBibliography(paper, "ieee", 2);
    const vancouver = formatBibliography(paper, "vancouver", 2);
    expect(apa).toContain("Lovelace, A.");
    expect(apa).toContain("https://doi.org/10.1234/example");
    expect(ieee.startsWith("[2]")).toBe(true);
    expect(vancouver.startsWith("2.")).toBe(true);
  });

  it("keeps author-role variants and institutional names in citations", () => {
    const institutionalPaper = {
      ...paper,
      creators: [{
        id: "institution-author",
        creatorType: "bookAuthor",
        name: "Research Methods Institute",
        fieldMode: "oneField",
        orderIndex: 0,
      }],
    } as LiteraturePaper;
    expect(formatCitation(institutionalPaper, "apa7")).toBe("(Research Methods Institute, 2024)");
    expect(formatBibliography(institutionalPaper, "apa7")).toContain("Research Methods Institute (2024)");
  });

  it("persists a selected style locally and rejects unknown values", () => {
    writeCitationStyle("chicago-author-date");
    expect(readCitationStyle()).toBe("chicago-author-date");
    window.localStorage.setItem("somniq-literature-citation-style-v1", "unknown");
    expect(readCitationStyle()).toBe("apa7");
  });

  it("imports and renders a local CSL style, then removes it cleanly", () => {
    const xml = [
      '<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">',
      "<info><title>Minimal author year</title><id>https://example.test/minimal-author-year</id><summary>Test style</summary></info>",
      '<citation><layout prefix="(" suffix=")">',
      '<names variable="author"><name form="short" and="text"/></names>',
      '<date variable="issued" prefix=", "><date-part name="year"/></date>',
      '<text variable="locator" prefix=", "/>',
      "</layout></citation>",
      '<bibliography><layout suffix=". " delimiter=" ">',
      '<names variable="author"><name name-as-sort-order="all" sort-separator=", " initialize-with=". " and="text"/></names>',
      '<date variable="issued" prefix=" (" suffix="). "><date-part name="year"/></date>',
      '<text variable="title" quotes="true"/>',
      "</layout></bibliography>",
      "</style>",
    ].join("");
    const imported = importCslStyle(xml);
    expect(imported?.source).toBe("csl");
    expect(readCitationStyles().some((style) => style.id === imported?.id)).toBe(true);
    expect(formatCitation(paper, imported!.id, 1, undefined, "p. 4")).toContain("(Lovelace and Hopper, 2024");
    expect(formatBibliography(paper, imported!.id)).toContain("A local-first research workflow");
    removeCslStyle(imported!.id);
    expect(readCitationStyles().some((style) => style.id === imported?.id)).toBe(false);
  });
});
