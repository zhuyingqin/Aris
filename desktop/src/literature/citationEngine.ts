import type { LiteratureLibraryCreator, LiteraturePaper } from "./literatureTypes";

export type BuiltinCitationStyleId = "apa7" | "ieee" | "chicago-author-date" | "vancouver";
/** Custom CSL ids are generated from the style metadata and intentionally
 * remain open-ended so a local Zotero style can become the active style. */
export type CitationStyleId = BuiltinCitationStyleId | (string & {});

export interface CitationStyle {
  id: CitationStyleId;
  name: string;
  description: string;
  source?: "builtin" | "csl";
  xml?: string;
}

export const CITATION_STYLES: CitationStyle[] = [
  { id: "apa7", name: "APA 7th", description: "Author–date with sentence-case titles.", source: "builtin" },
  { id: "ieee", name: "IEEE", description: "Numeric citations for engineering and computer science.", source: "builtin" },
  { id: "chicago-author-date", name: "Chicago author–date", description: "Author–date bibliography with a readable long form.", source: "builtin" },
  { id: "vancouver", name: "Vancouver", description: "Compact numbered references for biomedical writing.", source: "builtin" },
];

const styleStorageKey = "somniq-literature-citation-style-v1";
const customStylesStorageKey = "somniq-literature-citation-csl-v1";

const childElements = (node: Element | null | undefined): Element[] =>
  node ? Array.from(node.children) : [];

const childElement = (node: Element | null | undefined, name: string): Element | undefined =>
  childElements(node).find((candidate) => candidate.localName === name);

const elementText = (node: Element | null | undefined, name: string): string =>
  childElement(node, name)?.textContent?.trim() ?? "";

const cslDocument = (xml: string): Element | null => {
  if (typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (!document.documentElement || document.documentElement.localName !== "style") return null;
  if (document.getElementsByTagName("parsererror").length > 0) return null;
  return document.documentElement;
};

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const customStyleFromXml = (xml: string): CitationStyle | null => {
  const root = cslDocument(xml);
  if (!root) return null;
  const info = childElement(root, "info");
  const rawId = elementText(info, "id") || elementText(info, "title") || "local-style";
  const slug = rawId.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "local-style";
  const name = elementText(info, "title") || slug;
  const description = elementText(info, "summary") || "Imported local CSL style.";
  return {
    id: ("csl:" + slug + ":" + stableHash(xml)) as CitationStyleId,
    name,
    description,
    source: "csl",
    xml,
  };
};

const readCustomStyles = (): CitationStyle[] => {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(customStylesStorageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw): CitationStyle[] => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Partial<CitationStyle>;
      if (typeof candidate.id !== "string" || !candidate.id.startsWith("csl:") || typeof candidate.xml !== "string") return [];
      const parsed = customStyleFromXml(candidate.xml);
      return parsed && parsed.id === candidate.id ? [parsed] : [];
    });
  } catch {
    return [];
  }
};

const writeCustomStyles = (styles: CitationStyle[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(customStylesStorageKey, JSON.stringify(styles.map((style) => ({
      id: style.id,
      name: style.name,
      description: style.description,
      source: "csl",
      xml: style.xml,
    }))));
  } catch {
    // A restricted WebView may not expose localStorage.
  }
};

export const readCitationStyles = (): CitationStyle[] => [
  ...CITATION_STYLES,
  ...readCustomStyles(),
];

/** Parse and persist one CSL XML document selected by the researcher. */
export const importCslStyle = (xml: string): CitationStyle | null => {
  const style = customStyleFromXml(xml);
  if (!style) return null;
  const next = [...readCustomStyles().filter((candidate) => candidate.id !== style.id), style];
  writeCustomStyles(next);
  return style;
};

export const removeCslStyle = (styleId: CitationStyleId) => {
  writeCustomStyles(readCustomStyles().filter((style) => style.id !== styleId));
};

const citationStyleById = (styleId: CitationStyleId): CitationStyle | undefined =>
  readCitationStyles().find((style) => style.id === styleId);

type CitationCreator = Pick<LiteratureLibraryCreator, "creatorType" | "firstName" | "lastName" | "name" | "fieldMode">
  & { orderIndex?: number };

const trim = (value: unknown) => String(value ?? "").trim();

const creatorText = (creator: CitationCreator) => {
  if (creator.fieldMode === "oneField") return trim(creator.name);
  const twoField = [trim(creator.firstName), trim(creator.lastName)].filter(Boolean).join(" ");
  return twoField || trim(creator.name);
};

const creatorFamily = (creator: CitationCreator) =>
  creator.fieldMode === "oneField"
    ? creatorText(creator)
    : trim(creator.lastName) || trim(creator.name).split(/\s+/).filter(Boolean).at(-1) || creatorText(creator);

const isCitationAuthor = (creator: CitationCreator) => {
  const role = trim(creator.creatorType).toLocaleLowerCase();
  return role === "" || role === "author" || role === "bookauthor"
    || role === "seriesauthor" || role === "container-author"
    || role === "institutionalauthor" || role === "corporateauthor"
    || role === "organizationauthor";
};

export const citationCreatorsForPaper = (
  paper: LiteraturePaper,
  creators?: CitationCreator[],
): CitationCreator[] => {
  const normalized = (creators ?? paper.creators ?? [])
    .filter(isCitationAuthor)
    .sort((left, right) => (Number(left.orderIndex) || 0) - (Number(right.orderIndex) || 0));
  if (normalized.length > 0) return normalized;
  return paper.authors.map((name) => ({
    creatorType: "author",
    name,
    fieldMode: "oneField",
  }));
};

const authorNames = (paper: LiteraturePaper, creators?: CitationCreator[]) =>
  citationCreatorsForPaper(paper, creators).map(creatorText).filter(Boolean);

const apaNames = (paper: LiteraturePaper, creators?: CitationCreator[]) => {
  const creatorsList = citationCreatorsForPaper(paper, creators);
  if (creatorsList.length === 0) return "Unknown author";
  const names = creatorsList.map((creator) => {
    const family = creatorFamily(creator);
    const initials = [trim(creator.firstName)]
      .flatMap((value) => value.split(/[\s-]+/))
      .filter(Boolean)
      .map((value) => value[0].toUpperCase() + ".")
      .join(" ");
    return initials ? family + ", " + initials : family;
  });
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " & " + names[1];
  if (names.length <= 20) return names.slice(0, -1).join(", ") + ", & " + names.at(-1);
  return names.slice(0, 19).join(", ") + ", … " + names.at(-1);
};

const shortAuthor = (paper: LiteraturePaper, creators?: CitationCreator[]) => {
  const families = citationCreatorsForPaper(paper, creators).map(creatorFamily).filter(Boolean);
  if (families.length === 0) return "Unknown author";
  if (families.length === 1) return families[0];
  if (families.length === 2) return families.join(" & ");
  return families[0] + " et al.";
};

const publicationText = (paper: LiteraturePaper) => {
  const parts = [
    trim(paper.venue),
    paper.volume ? trim(paper.volume) : "",
    paper.issue ? "(" + trim(paper.issue) + ")" : "",
    paper.pages ? ", " + trim(paper.pages) : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const yearText = (paper: LiteraturePaper) => trim(paper.year ?? paper.date) || "n.d.";

const titleText = (paper: LiteraturePaper) => trim(paper.title) || "Untitled";

const doiText = (paper: LiteraturePaper) => {
  const doi = trim(paper.doi);
  return doi ? "https://doi.org/" + doi.replace(/^https?:\/\/doi.org\//i, "") : "";
};

type CslRenderContext = {
  root: Element;
  paper: LiteraturePaper;
  creators?: CitationCreator[];
  index: number;
  locator?: string;
};

const cslAttribute = (node: Element, name: string, fallback = "") =>
  node.getAttribute(name) ?? fallback;

const cslBoolean = (node: Element, name: string) => cslAttribute(node, name) === "true";

const applyCslFormatting = (value: string, node: Element) => {
  let result = value;
  const textCase = cslAttribute(node, "text-case");
  if (textCase === "lowercase") result = result.toLocaleLowerCase();
  if (textCase === "uppercase") result = result.toLocaleUpperCase();
  if (textCase === "capitalize-first") result = result ? result[0].toLocaleUpperCase() + result.slice(1) : result;
  if (textCase === "capitalize-all") result = result.replace(/\b\w/g, (character) => character.toLocaleUpperCase());
  if (cslBoolean(node, "quotes")) result = "“" + result + "”";
  return cslAttribute(node, "prefix") + result + cslAttribute(node, "suffix");
};

const metadataValue = (paper: LiteraturePaper, variable: string) => {
  const values: Record<string, string> = {
    title: paper.title,
    "container-title": paper.venue,
    volume: trim(paper.volume),
    issue: trim(paper.issue),
    page: trim(paper.pages),
    publisher: trim(paper.publisher),
    "publisher-place": trim(paper.place),
    edition: trim(paper.edition),
    genre: trim(paper.itemType),
    DOI: trim(paper.doi).replace(/^https?:\/\/doi.org\//i, ""),
    URL: trim(paper.url),
    ISBN: trim(paper.isbn),
    "citation-key": trim(paper.citationKey),
    locator: trim(paper.accessed),
  };
  if (variable === "locator") return "";
  const direct = values[variable] ?? values[variable.toLocaleLowerCase()];
  if (direct) return direct;
  const metadata = paper.metadataFields ?? {};
  const entry = Object.entries(metadata).find(([key]) => key.toLocaleLowerCase() === variable.toLocaleLowerCase());
  return entry ? trim(entry[1]) : "";
};

const cslDateValue = (paper: LiteraturePaper, variable: string) => {
  if (variable === "accessed") return trim(paper.accessed);
  return trim(paper.date ?? (paper.year ? String(paper.year) : ""));
};

const creatorsForVariable = (paper: LiteraturePaper, creators: CitationCreator[] | undefined, variable: string) => {
  const all = (creators ?? paper.creators ?? []).slice().sort(
    (left, right) => (Number(left.orderIndex) || 0) - (Number(right.orderIndex) || 0),
  );
  const role = variable.toLocaleLowerCase();
  if (role === "author") return citationCreatorsForPaper(paper, creators);
  const matching = all.filter((creator) => {
    const creatorRole = trim(creator.creatorType).toLocaleLowerCase();
    if (role === "editor") return creatorRole === "editor" || creatorRole === "bookeditor" || creatorRole === "serieseditor";
    if (role === "translator") return creatorRole === "translator";
    if (role === "illustrator") return creatorRole === "illustrator";
    return creatorRole === role;
  });
  return matching;
};

const givenNameForCsl = (creator: CitationCreator, initializeWith: string) => {
  const given = trim(creator.firstName);
  if (!given) return "";
  if (!initializeWith) return given;
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + initializeWith)
    .join(" ");
};

const renderCslName = (creator: CitationCreator, node: Element | undefined) => {
  const nameNode = node ?? document.createElement("name");
  const form = cslAttribute(nameNode, "form", "long");
  const family = creatorFamily(creator);
  if (form === "short") return family;
  const given = givenNameForCsl(creator, cslAttribute(nameNode, "initialize-with"));
  if (!given) return creatorText(creator);
  const sortOrder = cslAttribute(nameNode, "name-as-sort-order");
  return sortOrder === "all" || sortOrder === "first"
    ? family + cslAttribute(nameNode, "sort-separator", ", ") + given
    : given + " " + family;
};

const renderCslNames = (node: Element, context: CslRenderContext): string => {
  const variables = cslAttribute(node, "variable", "author").split(/\s+/).filter(Boolean);
  const creators = variables
    .map((variable) => ({ variable, values: creatorsForVariable(context.paper, context.creators, variable) }))
    .find((candidate) => candidate.values.length > 0);
  if (!creators) {
    const substitute = childElement(node, "substitute");
    if (substitute) {
      const fallback = childElements(substitute)
        .map((candidate) => renderCslNode(candidate, context))
        .find(Boolean) ?? "";
      return applyCslFormatting(fallback, node);
    }
    return "";
  }
  const nameNode = childElement(node, "name");
  const renderNode = nameNode ?? node;
  const minimum = Number(cslAttribute(renderNode, "et-al-min", "0"));
  const useFirst = Number(cslAttribute(renderNode, "et-al-use-first", "1"));
  const values = minimum > 0 && creators.values.length >= minimum
    ? creators.values.slice(0, Math.max(1, useFirst))
    : creators.values;
  const rendered = values.map((creator) => renderCslName(creator, nameNode));
  let result: string;
  if (minimum > 0 && creators.values.length >= minimum) {
    result = rendered.join(cslAttribute(renderNode, "delimiter", ", ")) + " et al.";
  } else {
    const delimiter = cslAttribute(renderNode, "delimiter", ", ");
    const and = cslAttribute(renderNode, "and");
    if (rendered.length === 2 && and) {
      result = rendered[0] + " " + (and === "symbol" ? "& " : "and ") + rendered[1];
    } else if (rendered.length > 2 && and) {
      result = rendered.slice(0, -1).join(delimiter) + delimiter + (and === "symbol" ? "& " : "and ") + rendered.at(-1);
    } else {
      result = rendered.join(delimiter);
    }
  }
  return applyCslFormatting(result, node);
};

const renderCslDate = (node: Element, context: CslRenderContext): string => {
  const raw = cslDateValue(context.paper, cslAttribute(node, "variable", "issued"));
  if (!raw) return "";
  const parts = raw.match(/(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/);
  if (!parts) return applyCslFormatting(raw, node);
  const dateParts = childElements(node).filter((candidate) => candidate.localName === "date-part");
  if (dateParts.length === 0) return applyCslFormatting(raw, node);
  const values: Record<string, string> = {
    year: parts[1] ?? "",
    month: parts[2] ?? "",
    day: parts[3] ?? "",
  };
  const rendered = dateParts
    .map((part) => {
      const value = values[cslAttribute(part, "name")];
      if (!value) return "";
      const form = cslAttribute(part, "form");
      const month = form === "long"
        ? ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(value)] ?? value
        : form === "short"
          ? ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(value)] ?? value
          : value;
      return applyCslFormatting(month, part);
    })
    .filter(Boolean)
    .join(cslAttribute(node, "delimiter", " "));
  return applyCslFormatting(rendered, node);
};

const itemTypeForCsl = (paper: LiteraturePaper) => {
  const type = trim(paper.itemType).toLocaleLowerCase();
  if (type === "article") return "article-journal";
  if (type === "conferencePaper".toLocaleLowerCase()) return "paper-conference";
  if (type === "thesis") return "thesis";
  if (type === "bookSection") return "chapter";
  return type || "article-journal";
};

const cslConditionMatches = (node: Element, context: CslRenderContext) => {
  const variables = cslAttribute(node, "variable").split(/\s+/).filter(Boolean);
  const variableMatch = variables.length === 0 || variables.some((variable) => (
    variable === "author" || variable === "editor"
      ? creatorsForVariable(context.paper, context.creators, variable).length > 0
      : Boolean(variable === "issued" ? cslDateValue(context.paper, variable) : metadataValue(context.paper, variable))
  ));
  const types = cslAttribute(node, "type").split(/\s+/).filter(Boolean);
  const typeMatch = types.length === 0 || types.includes(itemTypeForCsl(context.paper));
  const numeric = cslAttribute(node, "is-numeric").split(/\s+/).filter(Boolean);
  const numericMatch = numeric.length === 0 || numeric.every((variable) => /^\d/.test(metadataValue(context.paper, variable)));
  const matches = [variableMatch, typeMatch, numericMatch];
  const mode = cslAttribute(node, "match", "all");
  return mode === "any" ? matches.some(Boolean) : mode === "none" ? matches.every((value) => !value) : matches.every(Boolean);
};

const renderCslNode = (node: Element, context: CslRenderContext): string => {
  switch (node.localName) {
    case "layout":
    case "group": {
      const values = childElements(node)
        .map((child) => renderCslNode(child, context))
        .filter(Boolean);
      return applyCslFormatting(values.join(cslAttribute(node, "delimiter")), node);
    }
    case "text": {
      let value = "";
      const variable = cslAttribute(node, "variable");
      if (variable) {
        value = variable === "issued" || variable === "accessed"
          ? cslDateValue(context.paper, variable)
          : variable === "locator"
            ? trim(context.locator)
            : metadataValue(context.paper, variable);
      } else if (cslAttribute(node, "macro")) {
        const macro = childElements(context.root).find(
          (candidate) => candidate.localName === "macro" && candidate.getAttribute("name") === cslAttribute(node, "macro"),
        );
        value = macro ? childElements(macro).map((child) => renderCslNode(child, context)).filter(Boolean).join("") : "";
      } else if (node.hasAttribute("value")) {
        value = cslAttribute(node, "value");
      } else if (node.hasAttribute("term")) {
        value = cslAttribute(node, "term") === "et-al" ? "et al." : cslAttribute(node, "term");
      }
      return applyCslFormatting(value, node);
    }
    case "names":
      return renderCslNames(node, context);
    case "date":
      return renderCslDate(node, context);
    case "label": {
      const variable = cslAttribute(node, "variable");
      const value = variable === "page" && metadataValue(context.paper, variable) ? "p." : "";
      return applyCslFormatting(value, node);
    }
    case "choose": {
      const branch = childElements(node).find((candidate) => (
        candidate.localName === "else" || (candidate.localName === "if" || candidate.localName === "else-if") && cslConditionMatches(candidate, context)
      ));
      return branch ? childElements(branch).map((child) => renderCslNode(child, context)).filter(Boolean).join("") : "";
    }
    case "substitute":
      return childElements(node).map((child) => renderCslNode(child, context)).find(Boolean) ?? "";
    default:
      return childElements(node).map((child) => renderCslNode(child, context)).filter(Boolean).join("");
  }
};

const renderCustomCsl = (
  paper: LiteraturePaper,
  style: CitationStyle,
  area: "citation" | "bibliography",
  index: number,
  creators?: CitationCreator[],
  locator?: string,
) => {
  if (!style.xml) return "";
  const root = cslDocument(style.xml);
  const section = childElement(root, area);
  const layout = childElement(section, "layout");
  if (!layout) return "";
  return renderCslNode(layout, { root: root!, paper, creators, index, locator });
};

export function formatCitation(
  paper: LiteraturePaper,
  style: CitationStyleId = "apa7",
  index = 1,
  creators?: CitationCreator[],
  locator?: string,
): string {
  const customStyle = citationStyleById(style);
  if (customStyle?.xml) {
    const rendered = renderCustomCsl(paper, customStyle, "citation", index, creators, locator);
    if (rendered) return rendered;
  }
  const locatorText = trim(locator);
  if (style === "ieee" || style === "vancouver") {
    return "[" + Math.max(1, index) + "]" + (locatorText ? ", " + locatorText : "");
  }
  if (style === "chicago-author-date") {
    return "(" + shortAuthor(paper, creators) + " " + yearText(paper) + (locatorText ? ", " + locatorText : "") + ")";
  }
  return "(" + shortAuthor(paper, creators) + ", " + yearText(paper) + (locatorText ? ", " + locatorText : "") + ")";
}

export function formatBibliography(
  paper: LiteraturePaper,
  style: CitationStyleId = "apa7",
  index = 1,
  creators?: CitationCreator[],
): string {
  const customStyle = citationStyleById(style);
  if (customStyle?.xml) {
    const rendered = renderCustomCsl(paper, customStyle, "bibliography", index, creators);
    if (rendered) return rendered;
  }
  const publication = publicationText(paper);
  const doi = doiText(paper);
  const title = titleText(paper);
  const year = yearText(paper);
  const names = authorNames(paper, creators);
  if (style === "ieee") {
    return "[" + Math.max(1, index) + "] " + (names.join(", ") || "Unknown author") + ', "' + title + ',"'
      + (publication ? " " + publication + "," : "") + " " + year + (doi ? ". " + doi : "") + ".";
  }
  if (style === "vancouver") {
    return Math.max(1, index) + ". " + (names.join(", ") || "Unknown author") + ". " + title
      + (publication ? ". " + publication : "") + ". " + year + (doi ? ". doi:" + doi.replace("https://doi.org/", "") : "") + ".";
  }
  if (style === "chicago-author-date") {
    return shortAuthor(paper, creators) + ". " + year + '. "' + title + '."'
      + (publication ? " " + publication + "." : "") + (doi ? " " + doi + "." : "");
  }
  return apaNames(paper, creators) + " (" + year + "). " + title + "."
    + (publication ? " " + publication + "." : "") + (doi ? " " + doi + "." : "");
}

export function readCitationStyle(): CitationStyleId {
  if (typeof window === "undefined") return "apa7";
  try {
    const stored = window.localStorage.getItem(styleStorageKey);
    return readCitationStyles().some((style) => style.id === stored) ? stored as CitationStyleId : "apa7";
  } catch {
    return "apa7";
  }
}

export function writeCitationStyle(style: CitationStyleId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(styleStorageKey, style);
  } catch {
    // A restricted WebView may not expose localStorage. The in-memory choice
    // remains useful for the current panel.
  }
}
