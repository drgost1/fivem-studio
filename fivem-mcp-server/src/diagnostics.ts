/**
 * FXServer console diagnostics.
 *
 * The console is a firehose of colour-coded text. An agent that has to read
 * all of it to answer "did my change break anything?" burns tokens and still
 * misses things. This turns raw console lines into structured findings, and
 * is shared by get_errors and restart_and_verify so both classify identically.
 */

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Resource the line was attributed to, when the line names one. */
  resource: string | null;
  /** The line with colour/ANSI codes stripped. */
  text: string;
}

/** FXServer colour codes (^1 red, ^3 yellow, ...) and ANSI escapes. */
const COLOUR_CODE = /\^[0-9]/g;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

const ERROR_PATTERNS: RegExp[] = [
  /SCRIPT ERROR/i,
  /\[\s*ERROR\s*\]/,
  /error loading script/i,
  /failed to load/i,
  /couldn't (?:load|start|find)/i,
  /unable to load/i,
  /attempt to (?:index|call|compare|perform|concatenate)/i,
  /stack traceback/i,
  /unhandled (?:promise rejection|exception|error)/i,
  /no such export/i,
  /\bexception\b/i,
  /citizen:\/scripting\/lua\/scheduler\.lua/i,
];

const WARNING_PATTERNS: RegExp[] = [
  /\[\s*WARN(?:ING)?\s*\]/i,
  /\bwarning\b/i,
  /\bdeprecated\b/i,
];

/** Lines that match an error word but are routine startup chatter. */
const BENIGN_PATTERNS: RegExp[] = [
  /Creating script environments for/i,
  /Started resource/i,
  /Stopping resource/i,
  /error_?(?:count|s)?\s*[:=]\s*0\b/i,
];

const RESOURCE_PATTERNS: RegExp[] = [
  /\[\s*([A-Za-z0-9_.\-]{2,64})\s*\]/,          // [resource-name]
  /@([A-Za-z0-9_.\-]{2,64})\//,                  // @resource/file.lua
  /\bresource\s+['"]?([A-Za-z0-9_.\-]{2,64})/i,  // resource foo
];

/** Bracket tags that are log levels or FXServer channels, not resources. */
const NOT_A_RESOURCE = new Set([
  "error", "warn", "warning", "info", "debug", "script", "server", "client",
  "mainthrd", "svadmin", "citizen-server-impl", "c-scripting-core", "resources",
]);

export function stripConsoleCodes(line: string): string {
  return line.replace(ANSI_ESCAPE, "").replace(COLOUR_CODE, "").trimEnd();
}

function attributeResource(line: string): string | null {
  for (const pattern of RESOURCE_PATTERNS) {
    const match = pattern.exec(line);
    const name = match?.[1];
    if (name && !NOT_A_RESOURCE.has(name.toLowerCase())) return name;
  }
  return null;
}

/** Classifies one console line, or returns null when it is not a finding. */
export function classifyConsoleLine(rawLine: string): Diagnostic | null {
  const text = stripConsoleCodes(rawLine);
  if (!text.trim()) return null;
  if (BENIGN_PATTERNS.some((pattern) => pattern.test(text))) return null;

  const isError = ERROR_PATTERNS.some((pattern) => pattern.test(text))
    // A bare ^1 (red) line is FXServer's own error colour.
    || /\^1/.test(rawLine);
  const isWarning = !isError && (
    WARNING_PATTERNS.some((pattern) => pattern.test(text)) || /\^3/.test(rawLine)
  );
  if (!isError && !isWarning) return null;

  return {
    severity: isError ? "error" : "warning",
    resource: attributeResource(text),
    text: text.trim(),
  };
}

export interface DiagnosticsSummary {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** How many console lines were examined. */
  scannedLines: number;
}

/**
 * Classifies a block of console lines. Consecutive identical findings are
 * collapsed, because a Lua stack traceback repeats the same frame text and an
 * erroring loop can emit the same line hundreds of times per second.
 */
export function parseConsoleDiagnostics(lines: string[], opts: { resource?: string | null; limit?: number } = {}): DiagnosticsSummary {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const finding = classifyConsoleLine(line);
    if (!finding) continue;
    if (opts.resource && finding.resource && finding.resource.toLowerCase() !== opts.resource.toLowerCase()) continue;
    const key = `${finding.severity}:${finding.resource ?? ""}:${finding.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = finding.severity === "error" ? errors : warnings;
    if (bucket.length < limit) bucket.push(finding);
  }

  return { errors, warnings, scannedLines: lines.length };
}

export function formatDiagnostics(summary: DiagnosticsSummary): string {
  if (summary.errors.length === 0 && summary.warnings.length === 0) {
    return `No errors or warnings in ${summary.scannedLines} console line(s).`;
  }
  const render = (list: Diagnostic[], label: string) =>
    list.length === 0 ? [] : [
      `${label} (${list.length}):`,
      ...list.map((item) => `  ${item.resource ? `[${item.resource}] ` : ""}${item.text}`),
    ];
  return [
    ...render(summary.errors, "ERRORS"),
    ...render(summary.warnings, "WARNINGS"),
    `(scanned ${summary.scannedLines} line(s))`,
  ].join("\n");
}
