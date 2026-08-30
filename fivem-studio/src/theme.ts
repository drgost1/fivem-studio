import type { ResolvedTheme } from "./global";

export function monacoThemeName(theme: ResolvedTheme): string {
  if (theme === "light") return "qb-studio-light";
  if (theme === "high-contrast") return "qb-studio-high-contrast";
  return "qb-studio-dark";
}
