export const MANIFEST_SCALAR_FIELDS = ["fx_version", "game", "author", "version"] as const;
export const MANIFEST_LIST_FIELDS = ["shared_scripts", "client_scripts", "server_scripts", "files", "dependencies"] as const;

export type ManifestScalarField = typeof MANIFEST_SCALAR_FIELDS[number];
export type ManifestListField = typeof MANIFEST_LIST_FIELDS[number];

export interface ManifestFormValues {
  fx_version: string;
  game: string;
  author: string;
  version: string;
  shared_scripts: string[];
  client_scripts: string[];
  server_scripts: string[];
  files: string[];
  dependencies: string[];
}

export type ManifestParseResult =
  | { ok: true; values: ManifestFormValues }
  | { ok: false; reason: string };

interface Statement {
  field: ManifestScalarField | ManifestListField;
  start: number;
  end: number;
  indent: string;
  values: string[];
  comments: string[];
  hadLineEnding: boolean;
}

const FIELD_MAP: Record<string, ManifestScalarField | ManifestListField> = {
  fx_version: "fx_version",
  game: "game",
  author: "author",
  version: "version",
  shared_script: "shared_scripts",
  shared_scripts: "shared_scripts",
  client_script: "client_scripts",
  client_scripts: "client_scripts",
  server_script: "server_scripts",
  server_scripts: "server_scripts",
  file: "files",
  files: "files",
  dependency: "dependencies",
  dependencies: "dependencies",
};

function emptyValues(): ManifestFormValues {
  return {
    fx_version: "",
    game: "",
    author: "",
    version: "",
    shared_scripts: [],
    client_scripts: [],
    server_scripts: [],
    files: [],
    dependencies: [],
  };
}

function parseQuoted(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      value += source[index + 1];
      index += 1;
    } else if (char === quote) {
      return { value, end: index + 1 };
    } else {
      value += char;
    }
  }
  return null;
}

function lineEnd(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end + 1;
}

function parseListBody(body: string): string[] | null {
  const withoutComments = body.replace(/--[^\r\n]*/g, "");
  const values: string[] = [];
  let index = 0;
  while (index < withoutComments.length) {
    const whitespace = withoutComments.slice(index).match(/^[\s,]*/)?.[0].length ?? 0;
    index += whitespace;
    if (index >= withoutComments.length) break;
    const parsed = parseQuoted(withoutComments, index);
    if (!parsed) return null;
    values.push(parsed.value);
    index = parsed.end;
  }
  return values;
}

function scanStatements(source: string): { statements: Statement[]; error?: string } {
  const statements: Statement[] = [];
  const directive = /^([ \t]*)(fx_version|game|author|version|shared_scripts?|client_scripts?|server_scripts?|files?|dependenc(?:y|ies))\b/gm;
  for (const match of source.matchAll(directive)) {
    const keyword = match[2];
    const field = FIELD_MAP[keyword];
    const start = match.index!;
    let cursor = start + match[0].length;
    while (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
    let values: string[];
    let contentEnd: number;
    const quoted = parseQuoted(source, cursor);
    if (quoted) {
      if (MANIFEST_SCALAR_FIELDS.includes(field as ManifestScalarField) === false && keyword.endsWith("s")) {
        return { statements, error: `${keyword} must use a brace list or a singular directive for one value.` };
      }
      values = [quoted.value];
      contentEnd = quoted.end;
    } else if (source[cursor] === "{") {
      if (MANIFEST_SCALAR_FIELDS.includes(field as ManifestScalarField)) {
        return { statements, error: `${keyword} must contain one quoted value.` };
      }
      let quote: string | null = null;
      let close = -1;
      for (let index = cursor + 1; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
          if (char === "\\") index += 1;
          else if (char === quote) quote = null;
        } else if (char === "'" || char === '"') {
          quote = char;
        } else if (char === "-" && source[index + 1] === "-") {
          const nextLine = source.indexOf("\n", index + 2);
          index = nextLine < 0 ? source.length : nextLine;
        } else if (char === "}") {
          close = index;
          break;
        }
      }
      if (close < 0) return { statements, error: `${keyword} has an unterminated brace list.` };
      const parsed = parseListBody(source.slice(cursor + 1, close));
      if (!parsed) return { statements, error: `${keyword} contains a dynamic value the form cannot preserve safely.` };
      values = parsed;
      contentEnd = close + 1;
    } else {
      return { statements, error: `${keyword} contains a dynamic value the form cannot preserve safely.` };
    }

    const end = lineEnd(source, contentEnd);
    const trailing = source.slice(contentEnd, end).replace(/--[^\r\n]*/g, "").trim();
    if (trailing) return { statements, error: `${keyword} contains extra Lua syntax the form cannot preserve safely.` };
    statements.push({
      field,
      start,
      end,
      indent: match[1],
      values,
      comments: source.slice(start, end).match(/--[^\r\n]*/g) ?? [],
      hadLineEnding: end > 0 && source[end - 1] === "\n",
    });
  }
  return { statements };
}

export function parseManifestForm(source: string): ManifestParseResult {
  const scanned = scanStatements(source);
  if (scanned.error) return { ok: false, reason: scanned.error };
  const values = emptyValues();
  for (const statement of scanned.statements) {
    if (MANIFEST_SCALAR_FIELDS.includes(statement.field as ManifestScalarField)) {
      const field = statement.field as ManifestScalarField;
      if (values[field]) return { ok: false, reason: `${field} appears more than once.` };
      values[field] = statement.values[0] ?? "";
    } else {
      values[statement.field as ManifestListField].push(...statement.values);
    }
  }
  return { ok: true, values };
}

function sameValues(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function quoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function updateManifestForm(source: string, next: ManifestFormValues): string {
  const parsed = parseManifestForm(source);
  if (!parsed.ok) throw new Error(parsed.reason);
  const scanned = scanStatements(source);
  if (scanned.error) throw new Error(scanned.error);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const patches: Array<{ start: number; end: number; text: string }> = [];

  for (const field of [...MANIFEST_SCALAR_FIELDS, ...MANIFEST_LIST_FIELDS] as const) {
    const previous = parsed.values[field];
    const desired = next[field];
    const unchanged = typeof previous === "string"
      ? previous === desired
      : sameValues(previous, desired as string[]);
    if (unchanged) continue;
    const existing = scanned.statements.filter((statement) => statement.field === field);
    const comments = existing.flatMap((statement) => statement.comments);
    const indent = existing[0]?.indent ?? "";
    const commentText = comments.map((comment) => `${indent}${comment}${lineEnding}`).join("");
    let statementText = "";
    if (typeof desired === "string") {
      if (desired.trim()) statementText = `${indent}${field} ${quoted(desired.trim())}${lineEnding}`;
    } else if (desired.length > 0) {
      statementText = `${indent}${field} {${lineEnding}${desired.map((value) => `${indent}  ${quoted(value)},`).join(lineEnding)}${lineEnding}${indent}}${lineEnding}`;
    }
    const replacement = commentText + statementText;
    if (existing.length > 0) {
      patches.push({ start: existing[0].start, end: existing[0].end, text: replacement });
      for (const extra of existing.slice(1)) patches.push({ start: extra.start, end: extra.end, text: "" });
    } else if (replacement) {
      const prefix = source.length > 0 && !source.endsWith("\n") ? lineEnding : "";
      patches.push({ start: source.length, end: source.length, text: `${prefix}${replacement}` });
    }
  }

  return patches.sort((a, b) => b.start - a.start).reduce(
    (content, patch) => content.slice(0, patch.start) + patch.text + content.slice(patch.end),
    source,
  );
}
