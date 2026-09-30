import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID } from "@figloo/protocol";

export const DEFAULT_PORT = 47129;

export interface Config {
  token: string;
  port: number;
  allowedExtensionIds: string[];
}

export function configDir(): string {
  return process.env.FIGLOO_CONFIG_DIR ?? join(homedir(), ".figloo");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Reads ~/.figloo/config.json, creating it with a fresh pairing token on first run. */
export function loadOrCreateConfig(): Config {
  const path = configPath();
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch {
    // Missing or unreadable: fall through and create a new file.
  }
  const config: Config = {
    token: typeof stored.token === "string" && stored.token.length > 0 ? stored.token : randomBytes(24).toString("base64url"),
    port: typeof stored.port === "number" ? stored.port : DEFAULT_PORT,
    allowedExtensionIds: Array.isArray(stored.allowedExtensionIds) ? stored.allowedExtensionIds : [EXTENSION_ID],
  };
  if (process.env.FIGLOO_PORT) config.port = Number(process.env.FIGLOO_PORT);
  if (stored.token !== config.token || stored.port === undefined || stored.allowedExtensionIds === undefined) {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ token: config.token, port: stored.port ?? DEFAULT_PORT, allowedExtensionIds: config.allowedExtensionIds }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return config;
}
