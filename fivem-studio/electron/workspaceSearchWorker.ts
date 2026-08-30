import { parentPort } from "node:worker_threads";

interface RegexWorkerRequest {
  id: number;
  source: string;
  flags: string;
  content: string;
  maxMatches: number;
}

const port = parentPort;
if (!port) throw new Error("The workspace-search regex worker requires a parent port.");

port.on("message", (request: RegexWorkerRequest) => {
  try {
    const matcher = new RegExp(request.source, request.flags);
    const matches: Array<{
      index: number;
      text: string;
      captures: Array<string | undefined>;
      namedCaptures: Record<string, string>;
    }> = [];
    let found: RegExpExecArray | null;
    while (matches.length < request.maxMatches && (found = matcher.exec(request.content)) !== null) {
      matches.push({
        index: found.index,
        text: found[0],
        captures: found.slice(1),
        namedCaptures: Object.fromEntries(Object.entries(found.groups ?? {}).map(([name, value]) => [name, value ?? ""])),
      });
      if (found[0].length === 0) {
        const codePoint = request.content.codePointAt(matcher.lastIndex);
        matcher.lastIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      }
    }
    port.postMessage({ id: request.id, matches });
  } catch (error) {
    port.postMessage({ id: request.id, error: (error as Error).message || "The expression could not be evaluated." });
  }
});
