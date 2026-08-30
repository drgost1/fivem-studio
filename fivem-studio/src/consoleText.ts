export type ConsoleSeverity = "all" | "error" | "warning";

const ERROR_LINE = /(?:\^1|\b(?:error|fatal|exception|traceback|stack traceback|failed|failure|crash(?:ed)?)\b)/i;
const WARNING_LINE = /(?:\^3|\bwarn(?:ing)?\b)/i;
const STACK_LINE = /^\s*(?:at\s+|stack traceback:|\.\.\.|\[[^\]]+\]:\d+|[A-Za-z]:\\|\^\d)/i;

export function consoleLineSeverity(line: string): Exclude<ConsoleSeverity, "all"> | "info" {
  if (ERROR_LINE.test(line)) return "error";
  if (WARNING_LINE.test(line)) return "warning";
  return "info";
}

export function filterConsoleOutput(output: string, severity: ConsoleSeverity, textFilter: string): string {
  const needle = textFilter.trim().toLocaleLowerCase();
  return output
    .split(/\r?\n/)
    .filter((line) => severity === "all" || consoleLineSeverity(line) === severity)
    .filter((line) => !needle || line.toLocaleLowerCase().includes(needle))
    .join("\n");
}

export function newestErrorBlock(output: string): string | null {
  const lines = output.split(/\r?\n/);
  let errorIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (consoleLineSeverity(lines[index]) === "error") {
      errorIndex = index;
      break;
    }
  }
  if (errorIndex < 0) return null;

  let start = errorIndex;
  while (start > 0 && STACK_LINE.test(lines[start - 1])) start -= 1;
  let end = errorIndex + 1;
  while (end < lines.length && (STACK_LINE.test(lines[end]) || lines[end].trim() === "")) end += 1;
  return lines.slice(start, end).join("\n").trim() || null;
}

/** Count appended lines even when the server's rolling tail dropped old lines. */
export function countNewConsoleLines(previous: string, next: string): number {
  if (!next || next === previous) return 0;
  const before = previous.split(/\r?\n/);
  const after = next.split(/\r?\n/);
  const maximumOverlap = Math.min(before.length, after.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (before[before.length - overlap + index] !== after[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return after.length - overlap;
  }
  return after.length;
}

export function lastConsoleLines(output: string, count: number): string {
  return output.split(/\r?\n/).slice(-Math.max(0, count)).join("\n");
}
