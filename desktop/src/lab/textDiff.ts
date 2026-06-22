import type { CodeDiffLine } from "./CodeEditor";

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffTextLines(before: string, after: string): CodeDiffLine[] {
  if (before === after) return [];
  const left = splitLines(before);
  const right = splitLines(after);
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0) as number[]);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: CodeDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      result.push({ line: j + 1, type: "added", text: right[j] });
      j += 1;
    } else if (i < left.length) {
      result.push({ line: Math.max(1, j + 1), type: "removed", text: left[i] });
      i += 1;
    }
  }
  return result;
}
