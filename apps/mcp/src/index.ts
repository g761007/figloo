#!/usr/bin/env node
import { createRequire } from "node:module";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { configDir, configPath, loadOrCreateConfig, projectName } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { createServer } from "./server.js";
import { SnapshotStore } from "./snapshots.js";

/** Set by `pnpm package`, whose single-file bundle has no package.json next to it. */
declare const __FIGLOO_VERSION__: string | undefined;
const VERSION: string = typeof __FIGLOO_VERSION__ === "string" ? __FIGLOO_VERSION__ : createRequire(import.meta.url)("../package.json").version;
const command = process.argv[2] ?? "serve";

// Before the config is read, which would create it: doctor reports a missing one instead.
if (command === "doctor") {
  const checks = await runDoctor({ version: VERSION, ...(process.env.FIGLOO_PORT ? { portOverride: process.env.FIGLOO_PORT } : {}) });
  console.log(formatDoctor(VERSION, checks));
  process.exit(checks.some((check) => check.status === "problem") ? 1 : 0);
}
const config = loadOrCreateConfig();

if (command === "pair") {
  // Printing to stdout is fine here: the MCP transport is not started in pair mode.
  console.log(`Figloo pairing\n  token: ${config.token}\n  port:  ${config.port}\n  config: ${configPath()}\n\nPaste the token and port into the Figloo extension options page.`);
  process.exit(0);
}
if (command !== "serve") {
  console.error(`Unknown command "${command}". Use "serve" (default), "pair", or "doctor".`);
  process.exit(2);
}

const bridge = new Bridge({ ...config, serverVersion: VERSION, project: projectName() });
await bridge.start();
const server = createServer({ bridge, version: VERSION, snapshots: new SnapshotStore(join(configDir(), "snapshots"), config.snapshotTtlHours * 3_600_000) });
server.server.oninitialized = () => {
  const client = server.server.getClientVersion();
  bridge.session.client = client?.title ?? client?.name ?? null;
};
server.server.onclose = () => {
  void bridge.stop().finally(() => process.exit(0));
};
await server.connect(new StdioServerTransport());
