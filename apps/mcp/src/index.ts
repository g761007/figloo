#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { configPath, loadOrCreateConfig } from "./config.js";
import { createServer } from "./server.js";

/** Set by `pnpm package`, whose single-file bundle has no package.json next to it. */
declare const __FIGLOO_VERSION__: string | undefined;
const VERSION: string = typeof __FIGLOO_VERSION__ === "string" ? __FIGLOO_VERSION__ : createRequire(import.meta.url)("../package.json").version;
const command = process.argv[2] ?? "serve";
const config = loadOrCreateConfig();

if (command === "pair") {
  // Printing to stdout is fine here: the MCP transport is not started in pair mode.
  console.log(`Figloo pairing\n  token: ${config.token}\n  port:  ${config.port}\n  config: ${configPath()}\n\nPaste the token and port into the Figloo extension options page.`);
  process.exit(0);
}
if (command !== "serve") {
  console.error(`Unknown command "${command}". Use "serve" (default) or "pair".`);
  process.exit(2);
}

const bridge = new Bridge({ ...config, serverVersion: VERSION });
await bridge.start();
const server = createServer({ bridge, version: VERSION });
server.server.onclose = () => {
  void bridge.stop().finally(() => process.exit(0));
};
await server.connect(new StdioServerTransport());
