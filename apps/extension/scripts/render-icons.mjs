// Renders the extension icons from the SVG artwork below into static/icons/.
// The PNGs are committed; rerun `pnpm --filter @figloo/extension icons` after changing the artwork.
// Needs Playwright's Chromium: `pnpm exec playwright install chromium`.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const OUT_DIR = new URL("../static/icons/", import.meta.url);

// "color" marks a Figma design tab Figloo can use; "gray" is the default for every other tab.
const PALETTES = {
  color: [
    ["0", "#06B6D4"],
    ["0.55", "#6366F1"],
    ["1", "#D946EF"],
  ],
  gray: [
    ["0", "#A1A1AA"],
    ["1", "#71717A"],
  ],
};

// Toolbar icons need 16 and 32 px; the extensions page and install prompt use 48 and 128.
const OUTPUTS = [
  ["color", 16],
  ["color", 32],
  ["color", 48],
  ["color", 128],
  ["gray", 16],
  ["gray", 32],
];

/** An igloo on a rounded tile, drawn on a 128-unit grid. */
export function iconSvg(palette, size) {
  const stops = PALETTES[palette].map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join("");
  // Block seams read well from 32 px up; at 16 px they blur into noise, so they are left out.
  const seams =
    size >= 32
      ? '<path d="M20 78H44M84 78H108M33 58H95M32 78V92M96 78V92M42 58V78M86 58V78" fill="none" stroke="url(#g)" stroke-width="5"/>'
      : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">`,
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="128" y2="128">${stops}</linearGradient></defs>`,
    '<rect width="128" height="128" rx="28" fill="url(#g)"/>',
    '<path d="M18 92A46 46 0 0 1 110 92Z" fill="#fff"/>',
    '<path d="M50 92V78A14 14 0 0 1 78 78V92Z" fill="url(#g)"/>',
    seams,
    "</svg>",
  ].join("");
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [palette, size] of OUTPUTS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${iconSvg(palette, size)}</body>`);
  const png = await page.locator("svg").screenshot({ omitBackground: true });
  writeFileSync(new URL(`${palette}-${size}.png`, OUT_DIR), png);
  console.log(`icons/${palette}-${size}.png`);
}
await browser.close();
