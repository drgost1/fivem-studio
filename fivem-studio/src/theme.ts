import type { ResolvedTheme, ThemePack, ThemePreference } from "./global";
import { setInstalledThemePacks } from "./userThemeRegistry";

const CUSTOM_PROPERTIES = [
  "bg-0", "bg-1", "bg-2", "bg-3", "border", "border-strong", "text-0", "text-1", "text-2",
  "accent", "accent-hover", "accent-wash", "ok", "warn", "error", "warn-wash", "warn-border",
  "error-wash", "error-border", "diff-add", "diff-add-in", "diff-del", "diff-del-in", "scrollbar-hover",
  "modal-scrim", "text-on-solid",
] as const;

export function activateTheme(preference: Exclude<ThemePreference, "system">, packs: ThemePack[]): ResolvedTheme {
  setInstalledThemePacks(packs);
  for (const property of CUSTOM_PROPERTIES) document.documentElement.style.removeProperty(`--${property}`);
  if (preference.startsWith("custom:")) {
    const pack = packs.find((candidate) => `custom:${candidate.id}` === preference);
    if (pack) {
      document.documentElement.dataset.theme = pack.base;
      document.documentElement.style.colorScheme = pack.base === "light" ? "light" : "dark";
      for (const [property, color] of Object.entries(pack.colors)) {
        document.documentElement.style.setProperty(`--${property}`, color);
      }
      return preference;
    }
    preference = "dark";
  }
  document.documentElement.dataset.theme = preference;
  document.documentElement.style.colorScheme = preference === "light" ? "light" : "dark";
  return preference;
}
