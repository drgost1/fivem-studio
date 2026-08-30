import type { ThemePack } from "./global";

let installedThemePacks: ThemePack[] = [];

export function setInstalledThemePacks(packs: ThemePack[]): void {
  installedThemePacks = packs;
}

export function installedThemePack(id: string): ThemePack | null {
  return installedThemePacks.find((pack) => pack.id === id) ?? null;
}
