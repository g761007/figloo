import type { MapTokensOutput, TokenMatch } from "@figloo/protocol";
import type { ProjectScan, ProjectToken } from "./project-tokens.js";
import type { SnapshotSummary } from "./snapshot-summary.js";
import { deltaE, designColor, nameScore, nameWords, parseLength, parseWeight } from "./token-values.js";

/** Colors closer than this in Lab count as near; about 2.3 is the smallest difference people notice. */
export const NEAR_DELTA_E = 4;
/** Lengths and text sizes within this many pixels count as near. */
const NEAR_PX = 1;
const MAX_MATCHES = 3;
const MAX_CANDIDATES = 3;
const MIN_NAME_SCORE = 0.5;
/** A token this close in name to the variable a design value is bound to is that variable's token in the project. */
const VARIABLE_NAME_SCORE = 0.75;

type Mapped = Omit<MapTokensOutput, "snapshot" | "expiresAt" | "scanned" | "truncated">;

/** Puts the project's tokens and components next to a snapshot's design values. */
export function mapTokens(summary: SnapshotSummary, scan: ProjectScan): Mapped {
  const colors = scan.tokens.filter((t) => t.kind === "color");
  const lengths = scan.tokens.filter((t) => t.kind === "length");
  const fonts = scan.tokens.filter((t) => t.kind === "font");

  const spacing = new Map<string, { value: string; variable?: string; uses: ("gap" | "padding")[]; count: number; refs: string[] }>();
  for (const [use, values] of [["gap", summary.gaps], ["padding", summary.paddings]] as const) {
    for (const { value, variable, count, refs } of values) {
      const key = `${value}|${variable ?? ""}`;
      const entry = spacing.get(key) ?? { value, ...(variable ? { variable } : {}), uses: [], count: 0, refs: [] };
      entry.uses.push(use);
      entry.count += count;
      entry.refs = [...new Set([...entry.refs, ...refs])].slice(0, 5);
      spacing.set(key, entry);
    }
  }

  const mapped: Mapped = {
    colors: summary.colors.map(({ value, opacity, variable, uses, count, refs }) => ({
      value,
      opacity,
      ...(variable ? { variable } : {}),
      uses,
      count,
      refs,
      matches: colorMatches(value, opacity, variable, colors),
    })),
    typography: summary.typography.map(({ font, weight, size, lineHeight, count, refs }) => ({ font, weight, size, lineHeight, count, refs, matches: fontMatches(size, weight, fonts) })),
    spacing: [...spacing.values()].map((entry) => ({ ...entry, matches: lengthMatches(entry.value, entry.variable, "spacing", lengths) })),
    radii: summary.radii.map(({ value, variable, count, refs }) => ({ value, ...(variable ? { variable } : {}), count, refs, matches: lengthMatches(value, variable, "radius", lengths) })),
    components: summary.components.map(({ name, count, refs }) => ({ name, count, refs, candidates: candidates(name, scan) })),
    unmatched: { colors: 0, typography: 0, spacing: 0, radii: 0, components: 0 },
  };
  mapped.unmatched = {
    colors: mapped.colors.filter((c) => c.matches.length === 0).length,
    typography: mapped.typography.filter((t) => t.matches.length === 0).length,
    spacing: mapped.spacing.filter((s) => s.matches.length === 0).length,
    radii: mapped.radii.filter((r) => r.matches.length === 0).length,
    components: mapped.components.filter((c) => c.candidates.length === 0).length,
  };
  return mapped;
}

type Ranked = TokenMatch & { rank: number };

function match(token: ProjectToken, kind: TokenMatch["match"], difference: string | null, rank: number): Ranked {
  return { token: token.name, file: token.file, line: token.line, written: token.written, match: kind, difference, rank };
}

/** The best few, exact ones first, without the same token twice. */
function best(found: Ranked[]): TokenMatch[] {
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.rank - b.rank || a.token.localeCompare(b.token))
    .filter((m) => {
      const key = `${m.file}:${m.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_MATCHES)
    .map(({ rank: _rank, ...rest }) => rest);
}

/**
 * A hex color by its channels and alpha; a color style name, which the panel shows instead of a hex, by the token's name.
 * The token named like the variable the color is bound to comes first, and is near when its value differs.
 */
function colorMatches(value: string, opacity: string | null, variable: string | undefined, tokens: ProjectToken[]): TokenMatch[] {
  const wanted = designColor(value, opacity);
  if (!wanted) return best(tokens.filter((t) => nameScore(value, t.name) >= 0.6).map((t) => match(t, "near", "by name", 1 - nameScore(value, t.name))));
  const found: Ranked[] = [];
  for (const token of tokens) {
    const color = token.color!;
    const sameRgb = color.r === wanted.r && color.g === wanted.g && color.b === wanted.b;
    const alpha = Math.abs(color.a - wanted.a);
    const named = namedLike(variable, token);
    if (sameRgb && alpha <= 0.01) found.push(match(token, "exact", null, named ? -1 : 0));
    else if (named) found.push(match(token, "near", VARIABLE_VALUE_DIFFERS, -0.5));
    else if (sameRgb) found.push(match(token, "near", `alpha ${round(color.a)} vs ${round(wanted.a)}`, 1 + alpha));
    else {
      const distance = deltaE(color, wanted);
      if (distance <= NEAR_DELTA_E && alpha <= 0.05) found.push(match(token, "near", `ΔE ${distance.toFixed(1)}`, 2 + distance));
    }
  }
  return best(found);
}

const VARIABLE_VALUE_DIFFERS = "named like the variable; the value differs";
/** The token's name has the variable's words, or ends in them after a path such as theme.extend.colors. */
function namedLike(variable: string | undefined, token: ProjectToken): boolean {
  if (variable === undefined) return false;
  if (nameScore(variable, token.name) >= VARIABLE_NAME_SCORE) return true;
  const wanted = nameWords(variable);
  const tail = nameWords(token.name).slice(-wanted.length);
  return wanted.length > 0 && tail.length === wanted.length && tail.every((word, i) => word === wanted[i]);
}

/**
 * Spacing goes to spacing tokens and radii to radius tokens first; tokens whose name says neither come after.
 * The token named like the variable the value is bound to comes first, and is near when its value differs.
 */
function lengthMatches(value: string, variable: string | undefined, role: "spacing" | "radius", tokens: ProjectToken[]): TokenMatch[] {
  const wanted = parseLength(value);
  if (wanted === null) return [];
  const found: Ranked[] = [];
  for (const token of tokens) {
    const named = namedLike(variable, token);
    if (token.role !== role && token.role !== "other" && !named) continue;
    const other = token.role === role ? 0 : 0.5;
    const diff = Math.abs(token.length! - wanted);
    if (diff === 0) found.push(match(token, "exact", null, named ? -1 : other));
    else if (named) found.push(match(token, "near", VARIABLE_VALUE_DIFFERS, -0.5));
    else if (diff <= NEAR_PX) found.push(match(token, "near", `${round(diff)}px`, 1 + other + diff));
  }
  return best(found);
}

/** Text styles by size and weight; Figloo does not compare font families, which projects name in many ways. */
function fontMatches(size: string | null, weight: string | null, tokens: ProjectToken[]): TokenMatch[] {
  const wantedSize = size === null ? null : parseLength(size);
  if (wantedSize === null) return [];
  const wantedWeight = weight === null ? null : parseWeight(weight);
  const found: Ranked[] = [];
  for (const token of tokens) {
    const diff = Math.abs(token.size! - wantedSize);
    if (diff > NEAR_PX) continue;
    const weightDiffers = token.weight != null && wantedWeight !== null && token.weight !== wantedWeight;
    // A size-only token, such as a CSS font-size variable, covers the size but says nothing about the weight.
    const weightUnknown = token.weight == null && wantedWeight !== null;
    const notes = [diff > 0 ? `${round(diff)}px` : null, weightDiffers ? `weight ${token.weight} vs ${wantedWeight}` : null, weightUnknown ? "the token sets no weight" : null].filter(Boolean);
    found.push(match(token, notes.length === 0 ? "exact" : "near", notes.length === 0 ? null : notes.join(", "), (diff > 0 ? 1 : 0) + (weightDiffers ? 1 : 0) + (weightUnknown ? 0.5 : 0)));
  }
  return best(found);
}

/** Project components whose names share the most words with an instance's name. */
function candidates(name: string, scan: ProjectScan): MapTokensOutput["components"][number]["candidates"] {
  const seen = new Set<string>();
  return scan.components
    .map((component) => ({ ...component, score: Math.round(nameScore(name, component.name) * 100) / 100 }))
    .filter((c) => c.score >= MIN_NAME_SCORE)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .filter((c) => {
      const key = `${c.file}:${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Cuts the output until it fits: fewer refs first, then the least used values of the longest list. */
export function fitMapped(mapped: Mapped, fits: (candidate: Mapped) => boolean): { mapped: Mapped; truncated: boolean } {
  if (fits(mapped)) return { mapped, truncated: false };
  const lists = ["colors", "typography", "spacing", "radii", "components"] as const;
  const cut: Mapped = structuredClone(mapped);
  for (const list of lists) for (const item of cut[list]) item.refs = item.refs.slice(0, 1);
  while (!fits(cut)) {
    const longest = lists.reduce((a, b) => (cut[b].length > cut[a].length ? b : a));
    const list: { count: number }[] = cut[longest];
    if (list.length === 0) break;
    list.splice(list.indexOf(list.reduce((a, b) => (b.count < a.count ? b : a))), 1);
  }
  return { mapped: cut, truncated: true };
}
