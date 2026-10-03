// Acceptance run for the plan's core scenario on a real, signed-in Figma tab: starting from the
// layer the user selected inside a card, find the card, list its parts, read their values, take a
// screenshot, and export the selected layer, several times in a row. Every run must return exactly
// what the first one did, and the user's selection must be back afterwards.
//
// Needs: the extension paired in the browser, the Figma tab on screen, no other Figloo MCP server
// running, and one layer inside a card selected. Nothing is written to disk. The output lists
// refs, counts, sizes, and hashes, not layer names or other design content.
//
//   node tests/acceptance/core-scenario.mjs
//   FIGLOO_ACCEPT_RUNS=10 FIGLOO_ACCEPT_MCP_ENTRY=release/figloo-mcp-0.4.0.mjs node tests/acceptance/core-scenario.mjs
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dirname, "../..");
const RUNS = Number(process.env.FIGLOO_ACCEPT_RUNS ?? 10);
const MCP_ENTRY = resolve(ROOT, process.env.FIGLOO_ACCEPT_MCP_ENTRY ?? join("apps/mcp/dist/index.js"));
const FILE_KEY = process.env.FIGLOO_ACCEPT_FILE_KEY;
const CARD_TYPES = ["Component", "Instance", "Component set"];

const sha = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const fail = (message) => {
  throw new Error(message);
};

const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_ENTRY], stderr: "pipe" });
const client = new Client({ name: "figloo-acceptance", version: "0" });
await client.connect(transport);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) fail(`${name} failed: ${result.content?.[0]?.text}`);
  return result;
}

async function findTab() {
  for (let waited = 0; waited < 60_000; waited += 2_000) {
    const status = (await call("get_status", {})).structuredContent;
    const tabs = status.tabs.filter((tab) => (FILE_KEY ? tab.fileKey === FILE_KEY : true) && tab.readiness === "READY");
    if (status.extension.connected && tabs.length > 0) return tabs[0];
    await new Promise((r) => setTimeout(r, 2_000));
  }
  fail("no READY Figma tab; check get_status, the pairing, and that no other Figloo server is running");
}

/** One pass of the core scenario; returns what must match across runs, and what it cost. */
async function scenario(tabId) {
  const started = Date.now();
  const anchored = (await call("get_anchor", { tabId })).structuredContent;
  const { contextId, anchor } = anchored;
  let uiOps = 0;
  let listCalls = 0;
  let nodesRead = 0;
  const neighbors = async (ref, relation, extra = {}) => {
    const out = (await call("get_neighbors", { contextId, ref, relation, limit: 50, ...extra })).structuredContent;
    listCalls += 1;
    nodesRead += out.nodes.length;
    uiOps += out.uiOps;
    return out;
  };
  const ancestors = await neighbors(anchor.ref, "ancestors");
  const card = ancestors.nodes.find((node) => CARD_TYPES.includes(node.type)) ?? ancestors.nodes[0] ?? fail("the selected layer has no ancestor to treat as its card");
  const parts = await neighbors(card.ref, "children", { depth: 3 });
  const image = parts.nodes.find((node) => node.type === "Image");
  const texts = parts.nodes.filter((node) => node.type === "Text").slice(0, 2);
  const inspectRefs = [...new Set([card.ref, image?.ref, ...texts.map((t) => t.ref), anchor.ref].filter(Boolean))].slice(0, 5);
  const inspected = (await call("inspect_nodes", { contextId, refs: inspectRefs })).structuredContent;
  uiOps += inspected.uiOps;
  const shot = await call("capture", { contextId, ref: card.ref });
  const exported = (await call("export_asset", { contextId, ref: anchor.ref, format: "svg" })).structuredContent;
  const after = (await call("get_anchor", { tabId })).structuredContent;
  await call("release_context", { contextId });
  return {
    same: {
      anchor: anchor.ref,
      ancestors: ancestors.nodes.map((n) => n.ref),
      card: card.ref,
      parts: parts.nodes.map((n) => `${n.ref}:${n.type}`),
      partsComplete: parts.hasMore === false,
      inspected: sha(JSON.stringify(inspected.nodes)),
      capture: `${shot.structuredContent.width}x${shot.structuredContent.height}`,
      export: exported.files.map((f) => `${f.mimeType}:${f.bytes}:${sha(f.svg ?? "")}`).join(","),
      selectionAfter: after.anchor.ref,
    },
    cost: {
      ms: Date.now() - started,
      listCalls,
      nodesRead,
      uiOps,
      inspected: inspectRefs.length,
      restored: inspected.userSelectionRestored && shot.structuredContent.userSelectionRestored && exported.userSelectionRestored,
      exportSource: exported.source,
    },
  };
}

let failures = 0;
try {
  const tab = await findTab();
  console.log(`tab ${tab.tabId} (${tab.access} access), ${RUNS} runs, server ${MCP_ENTRY.replace(ROOT + "/", "")}`);
  let first = null;
  for (let run = 1; run <= RUNS; run += 1) {
    const { same, cost } = await scenario(tab.tabId);
    first ??= same;
    const differences = Object.keys(same).filter((key) => JSON.stringify(same[key]) !== JSON.stringify(first[key]));
    const problems = [...differences.map((key) => `${key} differs`)];
    if (same.selectionAfter !== same.anchor) problems.push("selection not restored");
    if (!cost.restored) problems.push("a tool reported userSelectionRestored: false");
    if (cost.exportSource !== "direct") problems.push(`export source ${cost.exportSource}`);
    if (problems.length > 0) failures += 1;
    console.log(
      `run ${run}: ${problems.length === 0 ? "ok" : problems.join("; ")} | anchor ${same.anchor} card ${same.card} parts ${same.parts.length}${same.partsComplete ? "" : "+"} inspect ${cost.inspected} ${same.inspected} capture ${same.capture} export ${same.export} | ${cost.listCalls} list calls, ${cost.nodesRead} layers read, ${cost.uiOps} UI ops, ${cost.ms} ms`,
    );
  }
  console.log(failures === 0 ? `PASS: ${RUNS} runs matched the first one` : `FAIL: ${failures} of ${RUNS} runs differed`);
} catch (error) {
  failures += 1;
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close();
  process.exitCode = failures === 0 ? 0 : 1;
}
