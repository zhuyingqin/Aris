import { describe, expect, it } from "vitest";
import { matchesSearchConditions, normalizeSearchConditions } from "../advancedSearch";
import type { LiteraturePaper } from "../literatureTypes";

const paper = {
  id: "paper-1",
  title: "A local-first research workflow",
  authors: ["Fallback Author"],
  creators: [
    {
      id: "creator-editor",
      creatorType: "editor",
      firstName: "Grace",
      lastName: "Hopper",
      fieldMode: "twoField",
      orderIndex: 1,
    },
    {
      id: "creator-author",
      creatorType: "author",
      firstName: "Ada",
      lastName: "Lovelace",
      fieldMode: "twoField",
      orderIndex: 0,
    },
    {
      id: "creator-group",
      creatorType: "author",
      name: "SomniQ Research Group",
      fieldMode: "oneField",
      orderIndex: 2,
    },
  ],
  metadataFields: {
    archiveLocation: "Shelf A",
    customFlag: "pilot",
  },
  year: 2024,
  date: "2024-06-01",
  venue: "Research Systems",
  abstract: "A grounded abstract",
  tags: ["local-first"],
  collectionIds: ["collection-1"],
  searchIds: [],
  itemType: "journalArticle",
  stage: "screened",
  starred: true,
  unread: false,
  source: "manual",
  addedAt: "2024-06-01T00:00:00.000Z",
  pdf: { status: "none" },
  attachments: [{
    id: "attachment-1",
    label: "Supplement",
    kind: "supplement",
    path: "papers/attachments/supplement.html",
    filename: "supplement.html",
    mimeType: "text/html",
    addedAt: "2024-06-01T00:00:00.000Z",
  }],
  notes: [{
    id: "note-1",
    title: "Methods",
    content: "Keep the audit trail",
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    source: "manual",
  }],
  evidence: [],
  answerChains: [],
  pdfAnnotations: [],
} as LiteraturePaper;

const condition = (
  id: string,
  field: string,
  operator: string,
  value: string,
  conditionIndex = 0,
  joiner?: string,
) => ({ id, field, operator, value, conditionIndex, joiner });

describe("advanced literature search", () => {
  it("drops incomplete value conditions but keeps empty/not-empty predicates", () => {
    const normalized = normalizeSearchConditions([
      condition("blank", "any", "contains", ""),
      condition("doi-empty", "doi", "isEmpty", "", 1),
      condition("custom", "any", "contains", "pilot", 2, "or"),
    ]);

    expect(normalized.map((entry) => entry.id)).toEqual(["doi-empty", "custom"]);
    expect(normalized[1].joiner).toBe("OR");
  });

  it("searches normalized creators, roles, extended fields, attachments and notes", () => {
    expect(matchesSearchConditions(paper, [
      condition("creator", "creator", "contains", "Lovelace"),
    ])).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("role", "creator", "is", "editor"),
    ])).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("extra", "any", "contains", "pilot"),
    ])).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("attachment", "attachment", "contains", "supplement.html"),
    ])).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("note", "note", "contains", "audit trail"),
    ])).toBe(true);
  });

  it("combines AND/OR rows and collection labels", () => {
    const collections = [{ id: "collection-1", label: "Writing" }];
    expect(matchesSearchConditions(paper, [
      condition("year", "year", "greaterThan", "2020"),
      condition("collection", "collection", "is", "Writing", 1),
    ], collections)).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("missing", "title", "contains", "missing"),
      condition("tag", "tag", "is", "local-first", 1, "OR"),
    ])).toBe(true);
  });

  it("compares partial publication dates instead of treating them as text", () => {
    expect(matchesSearchConditions(paper, [
      condition("after", "date", "greaterThan", "2023"),
    ])).toBe(true);
    expect(matchesSearchConditions(paper, [
      condition("before", "date", "lessThan", "2023"),
    ])).toBe(false);
    expect(matchesSearchConditions(paper, [
      condition("same", "date", "is", "2024-06-01"),
    ])).toBe(true);
  });
});
