function lines(value: string): string[] {
  return value ? value.split(/\r?\n/) : [];
}

/** Append only content that arrived after the previous rolling-tail snapshot.
 * This lets Clear view remain cleared across refreshes even when txAdmin drops
 * old lines from the head of its on-disk tail. */
export function appendConsoleSnapshot(previousRaw: string, nextRaw: string, visible: string, maximumLines = 200): string {
  if (!nextRaw || nextRaw === previousRaw) return visible;
  const before = lines(previousRaw);
  const after = lines(nextRaw);
  let overlap = 0;
  const maximumOverlap = Math.min(before.length, after.length);
  for (let candidate = maximumOverlap; candidate > 0; candidate -= 1) {
    let matches = true;
    for (let index = 0; index < candidate; index += 1) {
      if (before[before.length - candidate + index] !== after[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = candidate;
      break;
    }
  }
  return [...lines(visible), ...after.slice(overlap)].slice(-Math.max(1, maximumLines)).join("\n");
}
