// Opens the signed-in canary's browser profile in a window, so the maintainer can sign in to the Figma
// test account by hand, or change its preferences. Nothing is typed for them. Closing the window ends it.
//
//   node tests/canary/login.mjs [url]
//
// The profile lives outside the repository, in FIGLOO_CANARY_PROFILE or ~/.figloo/canary-profile.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const profile = process.env.FIGLOO_CANARY_PROFILE ?? join(homedir(), ".figloo", "canary-profile");
mkdirSync(profile, { recursive: true, mode: 0o700 });
chmodSync(profile, 0o700);

const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: null });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(process.argv[2] ?? "https://www.figma.com/login", { waitUntil: "domcontentloaded" });
console.log(`[login] profile ${profile} is open; close the window when done`);
// On macOS the browser keeps running after its last window closes, so wait for the pages instead.
while (context.pages().length > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
await context.close();
console.log("[login] closed");
