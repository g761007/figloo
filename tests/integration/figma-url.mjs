// The integration tests open a real Figma design file in a signed-out browser. Its link is not
// committed: set FIGLOO_E2E_FIGMA_URL, or put it in tests/integration/.env.local (see .env.example).
import { existsSync } from "node:fs";
import { join } from "node:path";

const local = join(import.meta.dirname, ".env.local");
if (!process.env.FIGLOO_E2E_FIGMA_URL && existsSync(local)) process.loadEnvFile(local);

const url = process.env.FIGLOO_E2E_FIGMA_URL;
if (!url) {
  console.error(
    "Set FIGLOO_E2E_FIGMA_URL to a Figma design file that anyone with the link can view, or add it to tests/integration/.env.local (see tests/integration/.env.example).",
  );
  process.exit(2);
}

export const FIGMA_URL = url;
