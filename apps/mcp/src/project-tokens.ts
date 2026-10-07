import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { type Rgba, parseArgbHex, parseCssColor, parseLength, parseWeight } from "./token-values.js";

export type TokenFormat = "css" | "json" | "script" | "colorset" | "swift" | "android-xml" | "kotlin" | "dart";
export type LengthRole = "spacing" | "radius" | "other";

/** A value the project defines under a name: a color, a length, or a text size with its weight when the definition gives one. */
export interface ProjectToken {
  kind: "color" | "length" | "font";
  name: string;
  /** Relative to the scanned root. */
  file: string;
  line: number;
  /** The definition as written, cut to one line. */
  written: string;
  color?: Rgba;
  length?: number;
  role?: LengthRole;
  size?: number;
  weight?: number | null;
}

export interface ProjectComponent {
  name: string;
  file: string;
  line: number;
}

export interface ProjectScan {
  /** Files read. */
  files: number;
  /** False when the scan stopped at its file or time limit. */
  complete: boolean;
  tokens: ProjectToken[];
  components: ProjectComponent[];
  sources: { file: string; format: TokenFormat; tokens: number }[];
}

/** Folders that hold dependencies, build output, or tool state rather than the project's own code. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "release", "coverage", "vendor", "target", "tmp",
  "Pods", "Carthage", "DerivedData", "xcuserdata", "__pycache__", "venv", "__tests__", "__mocks__",
]);
/** Lock files and configs without design values, minified and source map files, and tests, whose values are not the project's tokens. */
const SKIP_FILES = /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|composer\.(json|lock)|.*\.min\.\w+|.*\.map|.*\.(test|spec)\.\w+)$/i;
const MAX_FILE_BYTES = 512 * 1024;
export const MAX_SCAN_FILES = 20_000;
export const SCAN_BUDGET_MS = 15_000;

const RADIUS = /radius|radii|corner|round/i;
const SPACING = /spac|gap|gutter|padding|margin|inset|stack|grid/i;
const FONT_SIZE = /font-?size|text-?size|(^|[-_.])fs($|[-_.])/i;

function roleOf(name: string): LengthRole {
  return RADIUS.test(name) ? "radius" : SPACING.test(name) ? "spacing" : "other";
}

function formatOf(path: string): TokenFormat | null {
  const name = basename(path);
  if (SKIP_FILES.test(name) || name.startsWith(".env")) return null;
  if (name === "Contents.json" && dirname(path).endsWith(".colorset")) return "colorset";
  switch (extname(name).toLowerCase()) {
    case ".css": case ".scss": case ".sass": case ".less": return "css";
    case ".json": return "json";
    case ".js": case ".cjs": case ".mjs": case ".ts": case ".tsx": case ".jsx": case ".vue": case ".svelte": return "script";
    case ".swift": return "swift";
    case ".xml": return "android-xml";
    case ".kt": case ".kts": return "kotlin";
    case ".dart": return "dart";
    default: return null;
  }
}

/** Reads the project's token definitions and components, within a file count and a time limit. */
export async function scanProject(root: string, limits: { maxFiles?: number; budgetMs?: number; now?: () => number } = {}): Promise<ProjectScan> {
  const now = limits.now ?? Date.now;
  const deadline = now() + (limits.budgetMs ?? SCAN_BUDGET_MS);
  const maxFiles = limits.maxFiles ?? MAX_SCAN_FILES;
  const scan: ProjectScan = { files: 0, complete: true, tokens: [], components: [], sources: [] };
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) queue.push(path);
        continue;
      }
      const format = entry.isFile() ? formatOf(path) : null;
      if (!format) continue;
      if (scan.files >= maxFiles || now() > deadline) {
        scan.complete = false;
        return scan;
      }
      const size = await stat(path).then((s) => s.size).catch(() => Number.POSITIVE_INFINITY);
      if (size > MAX_FILE_BYTES) continue;
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      scan.files += 1;
      const file = relative(root, path);
      const found = extract(format, file, text);
      scan.tokens.push(...found.tokens);
      scan.components.push(...found.components);
      if (found.tokens.length > 0) scan.sources.push({ file, format, tokens: found.tokens.length });
    }
  }
  return scan;
}

/** The tokens and components one file defines. */
export function extract(format: TokenFormat, file: string, text: string): { tokens: ProjectToken[]; components: ProjectComponent[] } {
  const tokens: ProjectToken[] = [];
  const components: ProjectComponent[] = [];
  const lines = text.split("\n");
  const at = (line: number) => ({ file, line: line + 1, written: lines[line]!.trim().slice(0, 120) });
  const color = (name: string, line: number, value: Rgba | null) => {
    if (value) tokens.push({ kind: "color", name, ...at(line), color: value });
  };
  const length = (name: string, line: number, value: number | null, role = roleOf(name)) => {
    if (value !== null) tokens.push({ kind: "length", name, ...at(line), length: value, role });
  };
  const font = (name: string, line: number, size: number | null, weight: number | null) => {
    if (size !== null) tokens.push({ kind: "font", name, ...at(line), size, weight });
  };
  // A text style written over several lines: its size and weight within the next lines.
  const styleWithin = (line: number, size: RegExp, weight: RegExp) => {
    const window = lines.slice(line, line + 12).join("\n");
    const s = size.exec(window)?.[1];
    const w = weight.exec(window)?.[1];
    return { size: s === undefined ? null : Number.parseFloat(s), weight: w === undefined ? null : parseWeight(w) };
  };

  switch (format) {
    case "css":
      lines.forEach((line, i) => cssDeclarations(line, i));
      break;
    case "json":
      jsonTokens();
      break;
    case "colorset":
      colorset();
      break;
    case "script":
      scriptTokens();
      break;
    case "swift": {
      let owner = "";
      lines.forEach((line, i) => {
        owner = /\b(?:enum|struct|extension|class)\s+(\w+)/.exec(line)?.[1] ?? owner;
        const rgb = /(?:let|var)\s+(\w+)[^=]*=\s*(?:UI|NS)?Color\((?:\.sRGB,\s*)?red:\s*([\d.]+)\s*(\/\s*255(?:\.0)?)?\s*,\s*green:\s*([\d.]+)\s*(?:\/\s*255(?:\.0)?)?\s*,\s*blue:\s*([\d.]+)\s*(?:\/\s*255(?:\.0)?)?(?:\s*,\s*(?:alpha|opacity):\s*([\d.]+))?/.exec(line);
        if (rgb) {
          const scale = rgb[3] !== undefined || [rgb[2], rgb[4], rgb[5]].some((v) => Number.parseFloat(v!) > 1) ? 1 : 255;
          const c = (v: string) => Math.round(Number.parseFloat(v) * scale);
          color(rgb[1]!, i, { r: c(rgb[2]!), g: c(rgb[4]!), b: c(rgb[5]!), a: rgb[6] === undefined ? 1 : Number.parseFloat(rgb[6]) });
        }
        const hex = /(?:let|var)\s+(\w+)[^=]*=\s*(?:UI|NS)?Color\((?:hex|hexString|rgb)?:?\s*"?#?(?:0x)?([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})\b"?/.exec(line);
        if (hex && !rgb) color(hex[1]!, i, parseCssColor(`#${hex[2]}`));
        const number = /(?:let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
        if (number && roleOf(`${owner}.${number[1]}`) !== "other") length(`${owner ? `${owner}.` : ""}${number[1]}`, i, Number.parseFloat(number[2]!), roleOf(`${owner}.${number[1]}`));
        const system = /(?:let|var)\s+(\w+)[^=]*=\s*(?:Font\.|UIFont\.)?(?:system|systemFont)\(\s*(?:size|ofSize):\s*([\d.]+)(?:\s*,\s*weight:\s*\.?(\w+))?/.exec(line);
        const custom = /(?:let|var)\s+(\w+)[^=]*=\s*(?:Font|UIFont)(?:\.custom|\(name:)\(?\s*"[^"]*",\s*size:\s*([\d.]+)/.exec(line);
        if (system) font(system[1]!, i, Number.parseFloat(system[2]!), system[3] ? parseWeight(system[3]) : null);
        else if (custom) font(custom[1]!, i, Number.parseFloat(custom[2]!), null);
        const view = /\b(?:struct|class)\s+([A-Z]\w*)\s*:\s*[^{]*\b(?:View|UIView|UIControl|UIButton|UILabel|UICollectionViewCell|UITableViewCell)\b/.exec(line);
        if (view) components.push({ name: view[1]!, file, line: i + 1 });
      });
      break;
    }
    case "android-xml":
      lines.forEach((line, i) => {
        const c = /<color\s+name="([\w.]+)"\s*>\s*(#[0-9A-Fa-f]{3,8})\s*<\/color>/.exec(line);
        if (c) {
          const hex = c[2]!.slice(1);
          // Android writes alpha first: #ARGB and #AARRGGBB.
          color(c[1]!, i, hex.length === 3 ? parseCssColor(c[2]!) : hex.length === 4 ? parseArgbHex(`#${[...hex].map((d) => d + d).join("")}`) : parseArgbHex(c[2]!));
        }
        const d = /<dimen\s+name="([\w.]+)"\s*>\s*([\d.]+)\s*(dp|dip|sp|px)\s*<\/dimen>/.exec(line);
        if (d) {
          if (d[3] === "sp") font(d[1]!, i, Number.parseFloat(d[2]!), null);
          else length(d[1]!, i, Number.parseFloat(d[2]!));
        }
      });
      break;
    case "kotlin": {
      let owner = "";
      let composable = false;
      lines.forEach((line, i) => {
        owner = /\bobject\s+(\w+)/.exec(line)?.[1] ?? owner;
        const c = /(?:val|var)\s+(\w+)\s*(?::\s*Color)?\s*=\s*Color\(\s*0x([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})L?\s*\)/.exec(line);
        if (c) color(c[1]!, i, parseArgbHex(`0x${c[2]}`));
        const dp = /(?:val|var)\s+(\w+)\s*(?::\s*Dp)?\s*=\s*([\d.]+)\.dp\b/.exec(line);
        if (dp) length(`${owner ? `${owner}.` : ""}${dp[1]}`, i, Number.parseFloat(dp[2]!), roleOf(`${owner}.${dp[1]}`));
        const style = /(\w+)\s*(?::\s*TextStyle)?\s*=\s*TextStyle\(/.exec(line);
        if (style) {
          const { size, weight } = styleWithin(i, /fontSize\s*=\s*([\d.]+)\.sp/, /fontWeight\s*=\s*FontWeight\.(\w+)/);
          font(style[1]!, i, size, weight);
        }
        if (/@Composable/.test(line)) composable = true;
        const fun = /\bfun\s+([A-Z]\w*)\s*\(/.exec(line);
        if (fun && composable) components.push({ name: fun[1]!, file, line: i + 1 });
        if (fun || (!/@Composable/.test(line) && line.trim() && !line.trim().startsWith("@"))) composable = false;
      });
      break;
    }
    case "dart": {
      let owner = "";
      lines.forEach((line, i) => {
        owner = /\bclass\s+(\w+)/.exec(line)?.[1] ?? owner;
        const c = /(\w+)\s*=\s*(?:const\s+)?Color\(\s*0x([0-9A-Fa-f]{8})\s*\)/.exec(line);
        if (c) color(c[1]!, i, parseArgbHex(`0x${c[2]}`));
        const number = /(?:const|final)\s+(?:double\s+|int\s+)?(\w+)\s*=\s*(\d+(?:\.\d+)?)\s*;/.exec(line);
        if (number && roleOf(`${owner}.${number[1]}`) !== "other") length(`${owner ? `${owner}.` : ""}${number[1]}`, i, Number.parseFloat(number[2]!), roleOf(`${owner}.${number[1]}`));
        const style = /(\w+)\s*=\s*(?:const\s+)?TextStyle\(/.exec(line);
        if (style) {
          const { size, weight } = styleWithin(i, /fontSize:\s*([\d.]+)/, /fontWeight:\s*FontWeight\.(\w+)/);
          font(style[1]!, i, size, weight);
        }
        const widget = /\bclass\s+([A-Z]\w*)\s+extends\s+(?:StatelessWidget|StatefulWidget)/.exec(line);
        if (widget) components.push({ name: widget[1]!, file, line: i + 1 });
      });
      break;
    }
  }
  return { tokens, components };

  /** CSS custom properties and SCSS or Less variables, also inside styles written in script files. */
  function cssDeclarations(line: string, i: number): void {
    for (const match of line.matchAll(/(--[\w-]+|[$@][\w-]+)\s*:\s*([^;{}]+?)\s*(?:;|$)/g)) {
      const name = match[1]!;
      const value = match[2]!.replace(/\s*!default\s*$/, "");
      const c = parseCssColor(value);
      if (c) color(name, i, c);
      else if (FONT_SIZE.test(name)) font(name, i, parseLength(value), null);
      else if (roleOf(name) !== "other") length(name, i, parseLength(value));
    }
  }

  /** Design token files and theme objects: a color string anywhere, a length or a text size under a telling name. */
  function jsonTokens(): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const lineOf = (key: string) => Math.max(0, lines.findIndex((line) => line.includes(`"${key}"`)));
    const visit = (value: unknown, path: string[]) => {
      if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) visit(inner, ["$value", "value"].includes(key) ? path : [...path, key]);
        return;
      }
      const name = path.join(".");
      const key = path.at(-1);
      if (!key || (typeof value !== "string" && typeof value !== "number")) return;
      const c = typeof value === "string" ? parseCssColor(value) : null;
      if (c) color(name, lineOf(key), c);
      else if (FONT_SIZE.test(name)) font(name, lineOf(key), parseLength(String(value)), null);
      else if (roleOf(name) !== "other") length(name, lineOf(key), parseLength(String(value)));
    };
    visit(data, []);
  }

  /** An iOS asset catalog color: the light, or only, appearance of the colorset, whose folder names it. */
  function colorset(): void {
    let data: { colors?: { appearances?: unknown[]; color?: { components?: Record<string, string> } }[] };
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const entry = data.colors?.find((c) => !c.appearances) ?? data.colors?.[0];
    const parts = entry?.color?.components;
    if (!parts) return;
    const channel = (v: string | undefined) => {
      if (v === undefined) return Number.NaN;
      if (/^0x/i.test(v)) return Number.parseInt(v, 16);
      const n = Number.parseFloat(v);
      return v.includes(".") || n <= 1 ? Math.round(n * 255) : n;
    };
    const rgba = { r: channel(parts.red), g: channel(parts.green), b: channel(parts.blue), a: parts.alpha === undefined ? 1 : Number.parseFloat(parts.alpha) };
    if ([rgba.r, rgba.g, rgba.b, rgba.a].some(Number.isNaN)) return;
    const name = basename(dirname(file)).replace(/\.colorset$/, "");
    tokens.push({ kind: "color", name, file, line: 1, written: `${name}.colorset`, color: rgba });
  }

  /** Theme objects in JavaScript and TypeScript, such as a Tailwind config, read by their key paths, and components. */
  function scriptTokens(): void {
    const path: string[] = [];
    lines.forEach((line, i) => {
      cssDeclarations(line, i);
      const opened = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*\{|["']?([\w-]+)["']?\s*:\s*\{/.exec(line);
      const entry = /^\s*["']?([\w$.-]+)["']?\s*:\s*(?:["'`]([^"'`]+)["'`]|(-?\d+(?:\.\d+)?))\s*,?\s*$/.exec(line);
      if (entry) {
        const name = [...path.filter(Boolean), entry[1]!].join(".");
        const raw = entry[2] ?? entry[3]!;
        const c = parseCssColor(raw);
        if (c) color(name, i, c);
        else if (FONT_SIZE.test(name)) font(name, i, parseLength(raw), null);
        else if (roleOf(name) !== "other") length(name, i, parseLength(raw));
      }
      const component =
        /export\s+(?:default\s+)?function\s+([A-Z]\w*)/.exec(line) ??
        /(?:export\s+)?const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\(|React\.|forwardRef|memo|styled)/.exec(line) ??
        /^\s*function\s+([A-Z]\w*)\s*\(/.exec(line);
      if (component) components.push({ name: component[1]!, file, line: i + 1 });
      // The line's first brace opens the named object; other braces, such as a function body's, add no name.
      let named = opened ? (opened[1] ?? opened[2] ?? "") : "";
      for (const ch of line) {
        if (ch === "{") {
          path.push(named);
          named = "";
        } else if (ch === "}") path.pop();
      }
    });
    // A single-file component is named by its file.
    if (/\.(vue|svelte)$/.test(file)) components.push({ name: basename(file).replace(/\.\w+$/, ""), file, line: 1 });
  }
}
