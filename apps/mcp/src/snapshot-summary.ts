import type { InspectedSection, SnapshotLayer, SummarizeSnapshotOutput, SummaryColorUse } from "@figloo/protocol";

/** Example refs per value; fewer when the result would not fit otherwise. */
const MAX_REFS = 5;
/** Values per list at most, the ones fewest layers use dropped first; the result budget usually cuts sooner. */
const MAX_VALUES = 100;
const MAX_VARIANTS = 10;

export type SnapshotSummary = Omit<SummarizeSnapshotOutput, "snapshot" | "expiresAt">;

/** Layers that share one value: counted once per layer, with the first few refs as examples. */
class Tally<T> {
  private readonly entries = new Map<string, { value: T; layers: Set<string>; refs: string[] }>();

  add(key: string, value: () => T, ref: string): T {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { value: value(), layers: new Set(), refs: [] };
      this.entries.set(key, entry);
    }
    if (!entry.layers.has(ref)) {
      entry.layers.add(ref);
      if (entry.refs.length < MAX_REFS) entry.refs.push(ref);
    }
    return entry.value;
  }

  list(): Array<T & { count: number; refs: string[] }> {
    return [...this.entries.values()].map(({ value, layers, refs }) => ({ ...value, count: layers.size, refs }));
  }
}

const isTypography = (section: InspectedSection) => section.kind === "typography" || /^typography\d+$/.test(section.kind);
const property = (section: InspectedSection, name: string) => section.properties.find((p) => p.group === null && p.name === name)?.value ?? null;
const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
/** Scales read best in order: 2px, 4px, 8px; values without a number go last. */
const byNumber = (a: { value: string }, b: { value: string }) => {
  const [x, y] = [Number.parseFloat(a.value), Number.parseFloat(b.value)];
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? a.value.localeCompare(b.value) : Number.isNaN(x) ? 1 : -1;
  return x - y || a.value.localeCompare(b.value);
};

/**
 * Collects the design values of the given layers as the inspection panel showed them: colors with
 * what they color, text styles, gaps, padding sides, corner radii, border widths, shadows, and the
 * instances by name with their component properties. Hidden layers are left out. The lists are cut,
 * the values fewest layers use first, until `fits` accepts the summary.
 */
export function summarizeLayers(layers: SnapshotLayer[], fits: (summary: SnapshotSummary) => boolean): SnapshotSummary {
  const colors = new Tally<{ value: string; opacity: string | null; uses: SummaryColorUse[] }>();
  const typography = new Tally<{ font: string | null; weight: string | null; style: string | null; size: string | null; lineHeight: string | null; letterSpacing: string | null }>();
  const scales = { gaps: new Tally<{ value: string }>(), paddings: new Tally<{ value: string }>(), radii: new Tally<{ value: string }>(), borders: new Tally<{ value: string }>() };
  const shadows = new Tally<{ properties: InspectedSection["properties"]; colors: InspectedSection["colors"] }>();
  const components = new Tally<{ name: string; variants: Map<string, { properties: Record<string, string>; count: number }> }>();
  let summarized = 0;
  let hiddenSkipped = 0;

  for (const layer of layers) {
    if (layer.hidden) {
      hiddenSkipped += 1;
      continue;
    }
    summarized += 1;
    for (const section of layer.sections) {
      // A text layer's fill is its text color.
      const use: SummaryColorUse | null =
        section.kind === "colors" ? (layer.type === "Text" ? "text" : "fill") : section.kind === "borders" ? "border" : section.kind === "shadows" ? "shadow" : null;
      if (use) {
        for (const color of section.colors) {
          const entry = colors.add(`${color.value}|${color.opacity ?? ""}`, () => ({ value: color.value, opacity: color.opacity, uses: [] }), layer.ref);
          if (!entry.uses.includes(use)) entry.uses.push(use);
        }
      }
      if (section.kind === "shadows") {
        shadows.add(JSON.stringify([section.properties, section.colors]), () => ({ properties: section.properties, colors: section.colors }), layer.ref);
      }
      if (isTypography(section)) {
        const style = {
          font: property(section, "Font"),
          weight: property(section, "Weight"),
          style: property(section, "Style"),
          size: property(section, "Size"),
          lineHeight: property(section, "Line height"),
          letterSpacing: property(section, "Letter spacing"),
        };
        if (Object.values(style).some((value) => value !== null)) typography.add(JSON.stringify(style), () => style, layer.ref);
      }
      if (section.kind === "properties") {
        for (const p of section.properties) {
          const scale =
            p.group === null && p.name === "Gap" ? scales.gaps
            : p.group === "Padding" || (p.group === null && p.name === "Padding") ? scales.paddings
            : p.group === "Radius" || (p.group === null && p.name === "Radius") ? scales.radii
            : p.name === "Border" ? scales.borders
            : null;
          scale?.add(p.value, () => ({ value: p.value }), layer.ref);
        }
      }
    }
    if (layer.type === "Instance") {
      const entry = components.add(layer.name, () => ({ name: layer.name, variants: new Map() }), layer.ref);
      const properties: Record<string, string> = {};
      for (const section of layer.sections.filter((s) => s.kind === "componentProps")) {
        for (const p of section.properties) properties[p.group ? `${p.group}—${p.name}` : p.name] = p.value;
      }
      if (Object.keys(properties).length > 0) {
        const key = JSON.stringify(properties);
        const variant = entry.variants.get(key) ?? { properties, count: 0 };
        variant.count += 1;
        entry.variants.set(key, variant);
      }
    }
  }

  const summary: SnapshotSummary = {
    layers: summarized,
    hiddenSkipped,
    colors: colors.list().sort((a, b) => byCount(a, b) || a.value.localeCompare(b.value)),
    typography: typography.list().sort(byCount),
    gaps: scales.gaps.list().sort(byNumber),
    paddings: scales.paddings.list().sort(byNumber),
    radii: scales.radii.list().sort(byNumber),
    borders: scales.borders.list().sort(byNumber),
    shadows: shadows.list().sort(byCount),
    components: components
      .list()
      .map(({ variants, ...component }) => ({ ...component, variants: [...variants.values()].sort(byCount).slice(0, MAX_VARIANTS) }))
      .sort((a, b) => byCount(a, b) || a.name.localeCompare(b.name)),
    truncated: false,
  };
  return fit(summary, fits);
}

type ListKey = "colors" | "typography" | "gaps" | "paddings" | "radii" | "borders" | "shadows" | "components";
const LISTS: ListKey[] = ["colors", "typography", "gaps", "paddings", "radii", "borders", "shadows", "components"];

/** Without its least used entry; the order of the rest stays as it is. */
function dropRarest<T extends { count: number }>(list: T[]): T[] {
  let at = list.length - 1;
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]!.count < list[at]!.count) at = i;
  return list.filter((_, i) => i !== at);
}

function fit(summary: SnapshotSummary, fits: (summary: SnapshotSummary) => boolean): SnapshotSummary {
  let current = summary;
  for (const key of LISTS) {
    while ((current[key] as { count: number }[]).length > MAX_VALUES) current = { ...current, [key]: dropRarest(current[key] as { count: number }[]), truncated: true };
  }
  for (const refs of [MAX_REFS, 3, 1]) {
    const shortened = withRefs(current, refs);
    if (fits(shortened)) return shortened;
  }
  current = withRefs(current, 1);
  while (!fits(current)) {
    const longest = LISTS.reduce((a, b) => ((current[b] as unknown[]).length > (current[a] as unknown[]).length ? b : a));
    if ((current[longest] as unknown[]).length === 0) return current;
    current = { ...current, [longest]: dropRarest(current[longest] as { count: number }[]), truncated: true };
  }
  return current;
}

function withRefs(summary: SnapshotSummary, refs: number): SnapshotSummary {
  const cut = <T extends { refs: string[] }>(list: T[]): T[] => list.map((entry) => ({ ...entry, refs: entry.refs.slice(0, refs) }));
  return {
    ...summary,
    colors: cut(summary.colors),
    typography: cut(summary.typography),
    gaps: cut(summary.gaps),
    paddings: cut(summary.paddings),
    radii: cut(summary.radii),
    borders: cut(summary.borders),
    shadows: cut(summary.shadows),
    components: cut(summary.components),
  };
}
