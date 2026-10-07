/** A color as 0 to 255 channels and an alpha from 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/** A CSS color as Figma or a web project writes it: #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(), or rgba(). */
export function parseCssColor(text: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim());
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(text.trim());
  if (!rgb) return null;
  const channel = (part: string) => clamp255(part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part));
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
  return { r: channel(rgb[1]!), g: channel(rgb[2]!), b: channel(rgb[3]!), a: alpha };
}

/** An Android, Compose, or Flutter color: 0xAARRGGBB or #AARRGGBB, where the alpha comes first; six digits are opaque. */
export function parseArgbHex(text: string): Rgba | null {
  const digits = /^(?:0x|#)([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim())?.[1];
  if (!digits) return null;
  if (digits.length === 6) return parseCssColor(`#${digits}`);
  const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
  return { r: n(2), g: n(4), b: n(6), a: Math.round((n(0) / 255) * 1000) / 1000 };
}

/** A design color from a snapshot summary: a hex code and the opacity the panel shows, such as "40%". */
export function designColor(value: string, opacity: string | null): Rgba | null {
  const color = parseCssColor(value);
  if (!color) return null;
  return opacity === null ? color : { ...color, a: color.a * (Number.parseFloat(opacity) / 100) };
}

export function toHex({ r, g, b, a }: Rgba): string {
  const hex = (n: number) => clamp255(n).toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;
}

/** CIE76 color difference in Lab, ignoring alpha: about 2.3 is the smallest difference people notice. */
export function deltaE({ r: r1, g: g1, b: b1 }: Rgba, { r: r2, g: g2, b: b2 }: Rgba): number {
  const [l1, a1, bb1] = lab(r1, g1, b1);
  const [l2, a2, bb2] = lab(r2, g2, b2);
  return Math.hypot(l1 - l2, a1 - a2, bb1 - bb2);
}

function lab(r: number, g: number, b: number): [number, number, number] {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  // sRGB to XYZ (D65), relative to the reference white.
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** A length in design pixels: px as is, dp, sp, and pt as pixels at 1x, rem and em at 16 px. */
export function parseLength(text: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)\s*(px|dp|sp|pt|rem|em)?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  return /^r?em$/i.test(match[2] ?? "") ? value * 16 : value;
}

const WEIGHTS: [RegExp, number][] = [
  [/^(w?100|thin|hairline)$/i, 100],
  [/^(w?200|extra-?light|ultra-?light)$/i, 200],
  [/^(w?300|light)$/i, 300],
  [/^(w?400|regular|normal|book)$/i, 400],
  [/^(w?500|medium)$/i, 500],
  [/^(w?600|semi-?bold|demi-?bold)$/i, 600],
  [/^(w?700|bold)$/i, 700],
  [/^(w?800|extra-?bold|ultra-?bold|heavy)$/i, 800],
  [/^(w?900|black)$/i, 900],
];

/** A font weight as a number, from "500", "Medium", ".medium", "FontWeight.W500", or "FontWeight.w500". */
export function parseWeight(text: string): number | null {
  const name = text.trim().replace(/^(\.|FontWeight\.|UIFont\.Weight\.|Font\.Weight\.)/, "");
  return WEIGHTS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** The words of a name, for comparing a Figma layer or style name with a code symbol: "Button / Primary" and "PrimaryButton" share both. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** How well a code symbol's name covers a design name, from 0 to 1, with extra words in the symbol counting against it. */
export function nameScore(designName: string, symbol: string): number {
  const wanted = new Set(nameWords(designName));
  const offered = new Set(nameWords(symbol));
  if (wanted.size === 0 || offered.size === 0) return 0;
  const shared = [...wanted].filter((word) => offered.has(word)).length;
  return shared / Math.max(wanted.size, offered.size);
}
