export function parseCliArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of input) {
    if (quote === '"') {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (current) args.push(current);
  if (args[0]?.toLowerCase() === "aris" || args[0]?.toLowerCase() === "aris.exe") {
    args.shift();
  }
  return args;
}
