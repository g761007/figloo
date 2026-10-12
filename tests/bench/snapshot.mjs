// Snapshot benchmark: where snapshot_layer's time goes, phase by phase, on real Figma. It runs on the
// maintainer's machine, never in CI, and prints refs, layer counts, and milliseconds only.
//
//   node tests/bench/snapshot.mjs [--runs 3] [--refs 0:2,0:78] [--attach [--file <file key>]] [--json]
//
// Needs `pnpm build`. By default it opens the signed-in canary profile with the repo's extension at
// FIGLOO_CANARY_FIGMA_URL, as tests/canary/signed-in.mjs does (see there for the setup). With --attach it
// uses your own browser instead: it starts a server with your config (~/.figloo, or FIGLOO_CONFIG_DIR),
// which takes the port over from your agent sessions, so your browser's extension connects to it; keep
// the Figma tab in front, and with several Figma tabs name the file with --file. Your agent sessions take
// the port back on their next Figloo call.
//
// Without --refs it snapshots the selected layer (in the canary, the frame the link names); --refs takes
// that layer or layers directly on the current page. Every run reads Figma again (refresh), and a run
// that needs several calls goes on until the snapshot is complete.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    refs: { type: "string" },
    attach: { type: "boolean", default: false },
    file: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const RUNS = Number(args.runs);
const ROOT = resolve(import.meta.dirname, "../..");
const envFile = join(ROOT, "tests/integration/.env.local");
if (!process.env.FIGLOO_CANARY_FIGMA_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const FIGMA_URL = process.env.FIGLOO_CANARY_FIGMA_URL;
const PROFILE = process.env.FIGLOO_CANARY_PROFILE ?? join(homedir(), ".figloo", "canary-profile");
const EXTENSION_DIR = process.env.FIGLOO_E2E_EXTENSION_DIR ?? join(ROOT, "apps/extension/dist");
const MCP_ENTRY = process.env.FIGLOO_E2E_MCP_ENTRY ?? join(ROOT, "apps/mcp/dist/index.js");
const TOKEN = `bench-${Math.random().toString(36).slice(2)}`;
const HEADLESS = process.env.FIGLOO_E2E_HEADED !== "1";

const log = (...line) => console.log("[bench]", ...line);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error("--runs takes a whole number of at least 1.");
  process.exit(2);
}
if (!args.attach && (!FIGMA_URL || !existsSync(PROFILE))) {
  console.error("Set FIGLOO_CANARY_FIGMA_URL (or add it to tests/integration/.env.local) and sign in once with node tests/canary/login.mjs, or use --attach.");
  process.exit(2);
}
const FILE_KEY = args.attach ? args.file : new URL(FIGMA_URL).pathname.split("/")[2];

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The timings the server logged for each call of one snapshot, added up. */
function addUp(lines) {
  const ms = {};
  const counts = {};
  let calls = 0;
  for (const line of lines) {
    const match = /^\[figloo\] snapshot_layer (?:complete|partial) .* timings=(\{.*\})$/.exec(line);
    if (!match) continue;
    calls += 1;
    const timings = JSON.parse(match[1]);
    for (const [phase, value] of Object.entries(timings.ms)) ms[phase] = (ms[phase] ?? 0) + value;
    for (const [name, value] of Object.entries(timings.counts)) counts[name] = (counts[name] ?? 0) + value;
  }
  return { ms, counts, calls };
}

const workDir = mkdtempSync(join(tmpdir(), "figloo-bench-"));
const serverLines = [];
let client = null;
let context = null;
try {
  const port = args.attach ? null : await freePort();
  if (!args.attach) writeFileSync(join(workDir, "config.json"), JSON.stringify({ token: TOKEN, port }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    // The canary run keeps its config and snapshots in the temporary folder; an attached run uses yours.
    env: { ...process.env, CLAUDE_PROJECT_DIR: workDir, ...(args.attach ? {} : { FIGLOO_CONFIG_DIR: workDir, FIGLOO_PORT: String(port) }) },
    stderr: "pipe",
  });
  let partialLine = "";
  transport.stderr.on("data", (chunk) => {
    const lines = (partialLine + chunk.toString()).split("\n");
    partialLine = lines.pop();
    serverLines.push(...lines);
  });
  client = new Client({ name: "figloo-bench", version: "0" });
  await client.connect(transport);
  const call = async (name, toolArgs = {}) => {
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 300_000 });
    if (result.isError) {
      const { error } = JSON.parse(result.content.find((c) => c.type === "text").text);
      throw new Error(`${name} failed with ${error.code}: ${error.message}`);
    }
    return result.structuredContent;
  };

  if (!args.attach) {
    // The profile keeps the extension's service worker from an earlier run even after a rebuild, until the
    // extension reloads, which an extension loaded this way cannot; without the registration, the one on disk runs.
    rmSync(join(PROFILE, "Default", "Service Worker"), { recursive: true, force: true });
    // Figma's CDN rejects the default "HeadlessChrome" user agent, as in the integration tests.
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: "chromium",
      headless: HEADLESS,
      viewport: { width: 1600, height: 1000 },
      userAgent: HEADLESS ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" : undefined,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.fill("#token", TOKEN);
    await options.fill("#port", String(port));
    await options.click("button[type=submit]");
    await options.close();
    await (await context.newPage()).goto(FIGMA_URL, { waitUntil: "domcontentloaded" });
  }

  let tab = null;
  for (let i = 0; i < 60 && !tab; i += 1) {
    const status = await call("get_status");
    const tabs = (status.tabs ?? []).filter((t) => (FILE_KEY ? t.fileKey === FILE_KEY : true));
    if (args.attach && !FILE_KEY && tabs.length > 1) throw new Error(`${tabs.length} Figma tabs are open; name the file with --file <file key>`);
    const found = tabs[0];
    if (found && found.readiness === "READY" && found.visible !== false) tab = found;
    else {
      if (i % 5 === 0) log(found ? `waiting for the Figma tab (${found.readiness}${found.visible === false ? ", not in front" : ""})` : "waiting for a Figma tab");
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  if (!tab) throw new Error("no Figma tab was READY and in front within two minutes");
  log(`tab ${tab.tabId}: access=${tab.access} mirror=${tab.capabilities.mirrorDom}${args.attach ? " (your browser)" : " (canary profile)"}`);

  const anchored = await call("get_anchor", { tabId: tab.tabId }).catch(() => null);
  const page = args.refs ? await call("explore_page", { tabId: tab.tabId, limit: 50 }) : null;
  const refs = args.refs ? args.refs.split(",").map((ref) => ref.trim()) : anchored ? [anchored.anchor.ref] : [];
  if (refs.length === 0) throw new Error("nothing is selected in Figma; select a layer or pass --refs");
  const contextOf = (ref) => {
    if (anchored?.anchors.some((a) => a.ref === ref)) return anchored.contextId;
    if (page?.nodes.some((n) => n.ref === ref)) return page.contextId;
    throw new Error(`${ref} is neither selected nor directly on the current page`);
  };

  const results = [];
  for (const ref of refs) {
    const contextId = contextOf(ref);
    const runs = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const mark = serverLines.length;
      const started = Date.now();
      let snapshot = await call("snapshot_layer", { contextId, ref, refresh: true });
      while (!snapshot.complete) snapshot = await call("snapshot_layer", { contextId, ref });
      const wallMs = Date.now() - started;
      const timed = addUp(serverLines.slice(mark));
      runs.push({ layers: snapshot.layerCount, wallMs, ...timed });
      log(`${ref} run ${run}: ${snapshot.layerCount} layers in ${timed.calls} call(s), ${(wallMs / 1000).toFixed(1)} s`);
    }
    const layers = runs[0].layers;
    const phases = [...new Set(runs.flatMap((r) => Object.keys(r.ms)))].sort();
    const counts = [...new Set(runs.flatMap((r) => Object.keys(r.counts)))].sort();
    const summary = {
      ref,
      layers,
      runs: RUNS,
      wallMs: median(runs.map((r) => r.wallMs)),
      ms: Object.fromEntries(phases.map((p) => [p, median(runs.map((r) => r.ms[p] ?? 0))])),
      counts: Object.fromEntries(counts.map((c) => [c, median(runs.map((r) => r.counts[c] ?? 0))])),
    };
    results.push(summary);
    console.log(`\n${ref}: ${layers} layers, median of ${RUNS} run(s) ${(summary.wallMs / 1000).toFixed(1)} s, ${Math.round(summary.wallMs / layers)} ms per layer`);
    console.log("  phase                    median ms   per layer   share");
    for (const p of phases) {
      const value = summary.ms[p];
      console.log(`  ${p.padEnd(24)} ${String(Math.round(value)).padStart(9)}   ${(value / layers).toFixed(1).padStart(9)}   ${((value / summary.wallMs) * 100).toFixed(1).padStart(4)}%`);
    }
    if (counts.length > 0) console.log(`  counts: ${counts.map((c) => `${c}=${summary.counts[c]}`).join(", ")}`);
  }
  if (args.json) console.log(JSON.stringify(results));
} catch (error) {
  console.error("[bench] FAIL", error.message);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await client?.close().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
}
