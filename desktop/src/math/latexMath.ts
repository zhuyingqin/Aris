/** Shared, lossless helpers for display-math environments.
 *
 * The source editor must keep the user's TeX unchanged. These helpers only
 * canonicalize the name used by structural/rendering layers, so common
 * Markdown escaping such as `align\*` does not make an otherwise valid math
 * environment invisible to the visual renderer.
 */

const DISPLAY_MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*",
  "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
  "eqnarray", "eqnarray*", "displaymath",
]);

export function canonicalMathEnvironmentName(name: string): string {
  return name.trim().replace(/\\\*$/, "*");
}

export function isDisplayMathEnvironment(name: string): boolean {
  return DISPLAY_MATH_ENVIRONMENTS.has(canonicalMathEnvironmentName(name));
}

/** Repair only the escaped-star form in an environment marker, not arbitrary
 * TeX in the body. The source remains untouched; this is a render-time view.
 */
export function canonicalizeMathEnvironmentMarkers(value: string): string {
  return value.replace(
    /\\(begin|end)\{(equation|align|alignat|gather|multline|flalign|eqnarray)\\\*\}/g,
    (_match, command: string, name: string) => `\\${command}{${name}*}`,
  );
}

/** Wrap a standalone display-math environment for Markdown/quoted-text
 * renderers that otherwise only recognize `$`/`$$` delimiters. Callers that
 * have fenced-code semantics should split those fences before calling this.
 */
export function wrapBareDisplayMathEnvironments(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  const output: string[] = [];
  let insideDisplayMath = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = canonicalizeMathEnvironmentMarkers(lines[index]);
    const begin = /^([ \t]*)\\begin\{([^{}]+)\}[ \t]*$/.exec(line);
    if (!insideDisplayMath && begin && isDisplayMathEnvironment(begin[2])) {
      const environment = canonicalMathEnvironmentName(begin[2]);
      let endIndex = index + 1;
      while (endIndex < lines.length) {
        const end = /^[ \t]*\\end\{([^{}]+)\}[ \t]*$/.exec(
          canonicalizeMathEnvironmentMarkers(lines[endIndex]),
        );
        if (end && canonicalMathEnvironmentName(end[1]) === environment) break;
        endIndex += 1;
      }
      if (endIndex < lines.length) {
        output.push("$$");
        output.push(...lines.slice(index, endIndex + 1).map(canonicalizeMathEnvironmentMarkers));
        output.push("$$");
        index = endIndex;
        continue;
      }
    }

    output.push(line);
    if (line.trim() === "$$") insideDisplayMath = !insideDisplayMath;
  }

  return output.join("\n");
}

/**
 * KaTeX accepts `aligned`/`gathered` as inner math environments, but the
 * document-level `align` family is stripped by the Visual decoration layer
 * before rendering. Recreate the inner alignment wrapper so `&` and `\\` are
 * parsed instead of being emitted as a KaTeX error span.
 */
export function visualLatexForDisplayEnvironment(name: string, body: string): string {
  const canonicalName = canonicalMathEnvironmentName(name);
  const content = body.trim();
  if (/^(?:align|alignat|flalign|eqnarray)/.test(canonicalName)) {
    return `\\begin{aligned}${content}\\end{aligned}`;
  }
  if (/^(?:gather|multline)/.test(canonicalName)) {
    return `\\begin{gathered}${content}\\end{gathered}`;
  }
  return content;
}
