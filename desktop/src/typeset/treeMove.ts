/**
 * Where a dragged file tree entry may be dropped, and what path it lands on.
 *
 * Kept out of the explorer component because every interesting case here is a
 * rule, not a rendering: a folder cannot be dropped inside itself, a drop back
 * into the current parent is a no-op, and a drop onto a file means "into the
 * folder that file is in" (which is what every file manager does).
 */
import { dirname, normalizePath } from "./latexText";

export type TreeDropTarget = { path: string; isDir: boolean };

/**
 * The path `sourcePath` would move to when dropped on `target`, or null when
 * the drop must be refused.
 */
export function moveDestination(sourcePath: string, target: TreeDropTarget): string | null {
  const source = normalizePath(sourcePath);
  // Dropping on a file means dropping into its folder.
  const directory = target.isDir ? normalizePath(target.path) : dirname(normalizePath(target.path));
  if (!source) return null;
  const name = source.split("/").pop();
  if (!name) return null;
  // Already there: a drop that changes nothing should not round-trip through
  // the file system and invalidate every open editor for that path.
  if (dirname(source) === directory) return null;
  // A folder cannot contain itself, and moving it into its own subtree would
  // delete the destination along with the source.
  if (directory === source || directory.startsWith(`${source}/`)) return null;
  return directory ? `${directory}/${name}` : name;
}

/** Whether a drop on `target` is allowed at all, for the hover affordance. */
export function canDropOn(sourcePath: string | null, target: TreeDropTarget): boolean {
  return Boolean(sourcePath) && moveDestination(sourcePath!, target) !== null;
}

/** Rewrites the expanded-folder set after a move, so the folders the user had
 * open stay open at their new paths. */
export function remapExpandedPaths(expanded: Iterable<string>, from: string, to: string): Set<string> {
  const prefix = `${from}/`;
  const next = new Set<string>();
  for (const path of expanded) {
    if (path === from) next.add(to);
    else if (path.startsWith(prefix)) next.add(`${to}/${path.slice(prefix.length)}`);
    else next.add(path);
  }
  return next;
}
