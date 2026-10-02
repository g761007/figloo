// Renders the extension icons from the SVG artwork below into static/icons/.
// The PNGs are committed; rerun `pnpm --filter @figloo/extension icons` after changing the artwork.
// Needs Playwright's Chromium: `pnpm exec playwright install chromium`.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const OUT_DIR = new URL("../static/icons/", import.meta.url);

// "color" marks a Figma design tab Figloo can use; "gray" is the default for every other tab.
const TILES = {
  color: "#4F46E5",
  gray: "#8E939B",
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

/**
 * An igloo built from rows like a layers panel, white on a rounded tile, drawn on a 128-unit grid.
 * The glyph is drawn to fill the grid and scaled down onto the tile; the bottom row leaves the door open.
 */
export function iconSvg(palette, size) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">`,
    `<rect width="128" height="128" rx="28" fill="${TILES[palette]}"/>`,
    '<g transform="translate(64 64) scale(0.68) translate(-64 -64)" fill="#fff">',
    '<rect x="36" y="21" width="56" height="22" rx="11"/>',
    '<rect x="14" y="53" width="100" height="22" rx="11"/>',
    '<rect x="6" y="85" width="46" height="22" rx="11"/>',
    '<rect x="76" y="85" width="46" height="22" rx="11"/>',
    "</g>",
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
