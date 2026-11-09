import type { TypesetDocument, TypesetProject } from "../api/tauri";
import { basename, dirname, normalizePath } from "./latexText";

export type TypesetLibraryFolder = {
  path: string;
  name: string;
  folders: TypesetLibraryFolder[];
  documents: TypesetDocument[];
  documentCount: number;
  texFileCount?: number;
  modifiedEpochMs: number;
  primaryDocument?: TypesetDocument;
};

export type TypesetLibraryRow =
  | { kind: "folder"; folder: TypesetLibraryFolder; depth: number; expanded: boolean }
  | { kind: "document"; document: TypesetDocument; depth: number };

/** Keep the scanner's project boundaries, then retain each document's real
 * directory hierarchy inside its project. Include files stay in the editor. */
export function buildTypesetLibraryFolders(
  projects: TypesetProject[],
  documents: TypesetDocument[],
  rootLabel: string,
  sort: "modified" | "title",
  keepEmptyProjects: boolean,
): TypesetLibraryFolder[] {
  const roots = new Map<string, TypesetLibraryFolder>();
  const makeFolder = (path: string, name = basename(path) || rootLabel): TypesetLibraryFolder => ({
    path, name, folders: [], documents: [], documentCount: 0, modifiedEpochMs: 0,
  });
  const rootFor = (path: string, name?: string) => {
    const normalized = normalizePath(path);
    let folder = roots.get(normalized);
    if (!folder) {
      folder = makeFolder(normalized, name);
      roots.set(normalized, folder);
    }
    return folder;
  };
  for (const project of projects) {
    const folder = rootFor(project.path, project.path ? project.name : rootLabel);
    folder.texFileCount = project.texFileCount;
    folder.modifiedEpochMs = project.modifiedEpochMs;
  }
  for (const document of documents) {
    const directory = dirname(document.path);
    const owner = normalizePath(document.projectPath ?? directory);
    let folder = rootFor(owner);
    // An optimistic document may not have a scanner-owned project yet.
    const relative = owner && directory.startsWith(`${owner}/`)
      ? directory.slice(owner.length + 1)
      : owner === directory ? "" : directory;
    for (const part of relative.split("/").filter(Boolean)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.folders.find((candidate) => candidate.path === path);
      if (!child) {
        child = makeFolder(path);
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.documents.push(document);
  }

  const isMain = (document: TypesetDocument) => basename(document.path).toLowerCase() === "main.tex";
  const finish = (folder: TypesetLibraryFolder) => {
    folder.folders.forEach(finish);
    folder.folders.sort((left, right) => (sort === "modified" ? right.modifiedEpochMs - left.modifiedEpochMs : 0)
      || left.name.localeCompare(right.name, undefined, { numeric: true }) || left.path.localeCompare(right.path));
    folder.documents.sort((left, right) => (sort === "modified" ? right.modifiedEpochMs - left.modifiedEpochMs : 0)
      || left.title.localeCompare(right.title, undefined, { numeric: true }) || left.path.localeCompare(right.path));
    folder.documentCount = folder.documents.length + folder.folders.reduce((sum, child) => sum + child.documentCount, 0);
    folder.modifiedEpochMs = Math.max(folder.modifiedEpochMs, ...folder.documents.map((document) => document.modifiedEpochMs),
      ...folder.folders.map((child) => child.modifiedEpochMs));
    if (folder.texFileCount !== undefined) folder.texFileCount = Math.max(folder.texFileCount, folder.documentCount);
    const descendantMains = folder.folders.map((child) => child.primaryDocument).filter((document) => document && isMain(document));
    folder.primaryDocument = folder.documents.find(isMain) ?? descendantMains[0]
      ?? folder.documents[0] ?? folder.folders.find((child) => child.primaryDocument)?.primaryDocument;
  };
  const folders = Array.from(roots.values());
  folders.forEach(finish);
  return folders.filter((folder) => keepEmptyProjects || folder.documentCount > 0)
    .sort((left, right) => (sort === "modified" ? right.modifiedEpochMs - left.modifiedEpochMs : 0)
      || left.name.localeCompare(right.name, undefined, { numeric: true }) || left.path.localeCompare(right.path));
}

export function typesetLibraryRows(
  folders: TypesetLibraryFolder[],
  isExpanded: (folder: TypesetLibraryFolder, depth: number) => boolean,
): TypesetLibraryRow[] {
  const rows: TypesetLibraryRow[] = [];
  const visit = (folder: TypesetLibraryFolder, depth: number) => {
    const expanded = folder.documentCount > 0 && isExpanded(folder, depth);
    rows.push({ kind: "folder", folder, depth, expanded });
    if (!expanded) return;
    folder.folders.forEach((child) => visit(child, depth + 1));
    folder.documents.forEach((document) => rows.push({ kind: "document", document, depth: depth + 1 }));
  };
  folders.forEach((folder) => visit(folder, 0));
  return rows;
}
