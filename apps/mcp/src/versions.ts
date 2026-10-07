/** Compares dotted version numbers such as "0.3.0" part by part: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [a, b].map((version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0));
  for (let i = 0; i < Math.max(pa!.length, pb!.length); i += 1) {
    const diff = (pa![i] ?? 0) - (pb![i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
