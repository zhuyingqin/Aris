import type {
  LiteratureCollection,
  LiteraturePaper,
  LiteratureSearchCondition,
} from "./literatureTypes";

export type LiteratureSearchField =
  | "any"
  | "title"
  | "creator"
  | "publicationTitle"
  | "abstract"
  | "tag"
  | "itemType"
  | "year"
  | "date"
  | "doi"
  | "url"
  | "citationKey"
  | "rating"
  | "stage"
  | "read"
  | "starred"
  | "collection"
  | "attachment"
  | "note";

export type LiteratureSearchOperator =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "beginsWith"
  | "greaterThan"
  | "lessThan"
  | "isEmpty"
  | "isNotEmpty";

export const SEARCH_FIELD_OPTIONS: Array<{ value: LiteratureSearchField; labelCn: string; labelEn: string }> = [
  { value: "any", labelCn: "所有字段", labelEn: "Any field" },
  { value: "title", labelCn: "标题", labelEn: "Title" },
  { value: "creator", labelCn: "作者/贡献者", labelEn: "Creator" },
  { value: "publicationTitle", labelCn: "出版物", labelEn: "Publication" },
  { value: "abstract", labelCn: "摘要", labelEn: "Abstract" },
  { value: "tag", labelCn: "标签", labelEn: "Tag" },
  { value: "itemType", labelCn: "条目类型", labelEn: "Item type" },
  { value: "year", labelCn: "年份", labelEn: "Year" },
  { value: "date", labelCn: "日期", labelEn: "Date" },
  { value: "doi", labelCn: "DOI", labelEn: "DOI" },
  { value: "url", labelCn: "URL", labelEn: "URL" },
  { value: "citationKey", labelCn: "Citation key", labelEn: "Citation key" },
  { value: "rating", labelCn: "评分", labelEn: "Rating" },
  { value: "stage", labelCn: "研究阶段", labelEn: "Stage" },
  { value: "read", labelCn: "阅读状态", labelEn: "Read status" },
  { value: "starred", labelCn: "收藏状态", labelEn: "Starred" },
  { value: "collection", labelCn: "分类", labelEn: "Collection" },
  { value: "attachment", labelCn: "附件", labelEn: "Attachment" },
  { value: "note", labelCn: "笔记", labelEn: "Note" },
];

export const SEARCH_OPERATOR_OPTIONS: Array<{ value: LiteratureSearchOperator; labelCn: string; labelEn: string }> = [
  { value: "contains", labelCn: "包含", labelEn: "contains" },
  { value: "notContains", labelCn: "不包含", labelEn: "does not contain" },
  { value: "is", labelCn: "是", labelEn: "is" },
  { value: "isNot", labelCn: "不是", labelEn: "is not" },
  { value: "beginsWith", labelCn: "开头为", labelEn: "begins with" },
  { value: "greaterThan", labelCn: "大于", labelEn: "greater than" },
  { value: "lessThan", labelCn: "小于", labelEn: "less than" },
  { value: "isEmpty", labelCn: "为空", labelEn: "is empty" },
  { value: "isNotEmpty", labelCn: "不为空", labelEn: "is not empty" },
];

const fold = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();

type CreatorLike = NonNullable<LiteraturePaper["creators"]>[number];

const displayCreator = (creator: CreatorLike) => {
  if (creator.fieldMode === "oneField") return creator.name ?? "";
  return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim() || creator.name || "";
};

const scalarValues = (
  paper: LiteraturePaper,
  field: LiteratureSearchField,
  collections: LiteratureCollection[],
): string[] => {
  const creators = (paper.creators ?? []).map(displayCreator).filter(Boolean);
  const creatorRoles = (paper.creators ?? [])
    .map((creator) => creator.creatorType ?? "")
    .filter(Boolean);
  const attachments = (paper.attachments ?? []).flatMap((attachment) => [
    attachment.label,
    attachment.path,
    attachment.url,
    attachment.externalPath,
    attachment.filename,
    attachment.mimeType,
    attachment.hash,
  ]).filter(Boolean) as string[];
  const notes = (paper.notes ?? [])
    .flatMap((note) => [note.title, note.content, note.source])
    .filter(Boolean) as string[];
  const extra = Object.entries(paper.metadataFields ?? {})
    .flatMap(([key, value]) => [key, value]);
  switch (field) {
    case "title": return [paper.title];
    case "creator": return [...creators, ...paper.authors, ...creatorRoles];
    case "publicationTitle": return [paper.venue];
    case "abstract": return [paper.abstract];
    case "tag": return paper.tags;
    case "itemType": return [paper.itemType ?? ""];
    case "year": return paper.year === undefined ? [] : [String(paper.year)];
    case "date": return [paper.date ?? "", paper.year === undefined ? "" : String(paper.year)];
    case "doi": return [paper.doi ?? ""];
    case "url": return [paper.url ?? ""];
    case "citationKey": return [paper.citationKey ?? ""];
    case "rating": return paper.rating === undefined ? [] : [String(paper.rating)];
    case "stage": return [paper.stage];
    case "read": return [paper.unread ? "unread" : "read", paper.unread ? "未读" : "已读"];
    case "starred": return [paper.starred ? "true" : "false", paper.starred ? "yes" : "no"];
    case "collection":
      return paper.collectionIds.flatMap((id) => [
        id,
        collections.find((collection) => collection.id === id)?.label ?? "",
      ]);
    case "attachment": return attachments;
    case "note": return notes;
    case "any":
    default:
      return [
        paper.title,
        ...paper.authors,
        ...creators,
        paper.venue,
        paper.abstract,
        ...paper.tags,
        paper.itemType ?? "",
        paper.date ?? "",
        paper.doi ?? "",
        paper.url ?? "",
        paper.citationKey ?? "",
        ...extra,
        ...attachments,
        ...notes,
      ];
  }
};

const numericField = (field: string) => field === "year" || field === "rating";

/** Convert partial Zotero-style dates into a comparable timestamp. */
const dateComparable = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d{4}$/.test(normalized)) return Date.UTC(Number(normalized), 0, 1);
  const monthMatch = /^(\d{4})-(\d{1,2})$/.exec(normalized);
  if (monthMatch) return Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1);
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const matchesOne = (
  values: string[],
  condition: LiteratureSearchCondition,
): boolean => {
  const operator = (condition.operator || "contains") as LiteratureSearchOperator;
  const needle = fold(condition.value);
  if (operator === "isEmpty") return values.every((value) => !fold(value));
  if (operator === "isNotEmpty") return values.some((value) => Boolean(fold(value)));
  if (values.length === 0) return operator === "notContains" || operator === "isNot";
  if (condition.field === "date" && ["greaterThan", "lessThan", "is", "isNot"].includes(operator)) {
    const target = dateComparable(condition.value);
    const dates = values.map(dateComparable).filter((value): value is number => value !== null);
    if (target === null || dates.length === 0) return false;
    if (operator === "greaterThan") return dates.some((value) => value > target);
    if (operator === "lessThan") return dates.some((value) => value < target);
    return operator === "is"
      ? dates.some((value) => value === target)
      : dates.every((value) => value !== target);
  }
  if (numericField(condition.field) && ["greaterThan", "lessThan", "is", "isNot"].includes(operator)) {
    const target = Number(condition.value);
    const numbers = values.map(Number).filter(Number.isFinite);
    if (!Number.isFinite(target) || numbers.length === 0) return false;
    if (operator === "greaterThan") return numbers.some((value) => value > target);
    if (operator === "lessThan") return numbers.some((value) => value < target);
    return operator === "is"
      ? numbers.some((value) => value === target)
      : numbers.every((value) => value !== target);
  }
  if (operator === "notContains" || operator === "isNot") {
    return values.every((value) => {
      const candidate = fold(value);
      return operator === "notContains" ? !candidate.includes(needle) : candidate !== needle;
    });
  }
  return values.some((value) => {
    const candidate = fold(value);
    switch (operator) {
      case "is": return candidate === needle;
      case "beginsWith": return candidate.startsWith(needle);
      case "contains":
      default: return candidate.includes(needle);
    }
  });
};

export function matchesSearchConditions(
  paper: LiteraturePaper,
  conditions: LiteratureSearchCondition[],
  collections: LiteratureCollection[] = [],
): boolean {
  const active = normalizeSearchConditions(conditions);
  if (active.length === 0) return true;
  let result = matchesOne(scalarValues(paper, active[0].field as LiteratureSearchField, collections), active[0]);
  for (let index = 1; index < active.length; index += 1) {
    const condition = active[index];
    const matched = matchesOne(scalarValues(paper, condition.field as LiteratureSearchField, collections), condition);
    result = (condition.joiner ?? "AND").toLocaleUpperCase() === "OR"
      ? result || matched
      : result && matched;
  }
  return result;
}

export function normalizeSearchConditions(
  conditions: LiteratureSearchCondition[],
): LiteratureSearchCondition[] {
  return conditions
    .filter((condition) => {
      if (!condition.field?.trim()) return false;
      const operator = condition.operator || "contains";
      return operator === "isEmpty"
        || operator === "isNotEmpty"
        || Boolean(String(condition.value ?? "").trim());
    })
    .map((condition, conditionIndex) => ({
      id: condition.id || "condition-" + (conditionIndex + 1),
      conditionIndex,
      field: condition.field.trim(),
      operator: condition.operator || "contains",
      value: condition.value ?? "",
      ...(conditionIndex > 0 ? { joiner: condition.joiner?.toLocaleUpperCase() === "OR" ? "OR" : "AND" } : {}),
    }));
}

export function describeSearchConditions(
  conditions: LiteratureSearchCondition[],
  language: "cn" | "en",
): string {
  return normalizeSearchConditions(conditions).map((condition, index) => {
    const field = SEARCH_FIELD_OPTIONS.find((option) => option.value === condition.field);
    const operator = SEARCH_OPERATOR_OPTIONS.find((option) => option.value === condition.operator);
    const fieldLabel = field ? (language === "cn" ? field.labelCn : field.labelEn) : condition.field;
    const operatorLabel = operator ? (language === "cn" ? operator.labelCn : operator.labelEn) : condition.operator;
    const joiner = index > 0 ? " " + (condition.joiner === "OR" ? "OR" : "AND") + " " : "";
    return joiner + fieldLabel + " " + operatorLabel + (condition.value ? " " + condition.value : "");
  }).join("");
}
