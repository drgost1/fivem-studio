export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "lua":
      return "lua";
    case "json":
      return "json";
    case "js":
    case "cjs":
    case "mjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "html":
      return "html";
    case "css":
      return "css";
    case "cfg":
      return "ini";
    case "sql":
      return "sql";
    case "xml":
    case "meta":
      return "xml";
    default:
      return "plaintext";
  }
}
