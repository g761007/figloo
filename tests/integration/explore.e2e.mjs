// Real-DOM check for M2 navigation: the same adapter the content script uses, injected into a
// visible guest Figma tab. Guests cannot select layers, so the anchor itself is covered by the
// captured-markup tests; this covers expand, list, page, climb, and restore on live Figma.
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const FIGMA_URL =
  process.env.FIGLOO_E2E_FIGMA_URL ??
  "https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=338-4231&p=f&t=abc-0";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const MAX_LIST_CALLS = 40;

const log = (...args) => console.log("[explore]", ...args);
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

const bundle = await build({
  entryPoints: [join(ROOT, "apps/extension/src/adapter/ops.ts")],
  bundle: true,
  format: "iife",
  globalName: "FiglooAdapter",
  target: "chrome116",
  write: false,
});

const browser = await chromium.launch({ channel: "chromium", headless: process.env.FIGLOO_E2E_HEADED !== "1" });
try {
  const page = await (await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(FIGMA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label^="Expand UI"]', { timeout: 120_000 });
  await page.click('button[aria-label^="Expand UI"]');
  await page.waitForSelector('[data-testid="objects-panel"] [role="row"]', { timeout: 30_000 });
  // Evaluated through the debugging protocol, so Figma's content security policy does not block it.
  await page.evaluate(`${bundle.outputFiles[0].text}\nwindow.FiglooAdapter = FiglooAdapter; true`);

  const expandedRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="objects-panel"] [role="row"][aria-expanded="true"]')]
        .map((row) => row.querySelector('[data-testid$="-layers-panel-row"]').dataset.testid)
        .sort(),
    );
  const before = await expandedRows();

  let calls = 0;
  const list = async (ref, relation, from = 1, limit = 50, after) => {
    calls += 1;
    assert(calls <= MAX_LIST_CALLS, "the search stays within its call budget");
    const result = await page.evaluate(async (args) => {
      window.__explorer ??= new window.FiglooAdapter.Explorer("e2e", document, window);
      try {
        return { ok: true, value: await window.__explorer.listNeighbors({ expect: window.__explorer.identity(), ...args }) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    }, { ref, relation, from, limit, ...(after ? { after } : {}) });
    if (!result.ok) throw new Error(`${relation} of ${ref} failed: ${result.code} ${result.message}`);
    assert(result.value.elapsedMs < 15_000, `${relation} of ${ref} stays within the 15 s budget`);
    return result.value;
  };

  const firstRef = await page.evaluate(() => document.querySelector('[data-testid="objects-panel"] [data-testid$="-layers-panel-row"]').dataset.testid.replace("-layers-panel-row", ""));
  const top = await list(firstRef, "siblings");
  log(`top level: ${top.nodes.length} of ${top.total} layers, uiOps=${top.uiOps}, ${Math.round(top.elapsedMs)} ms`);
  assert(top.total !== null && top.nodes.length === Math.min(top.total, 50), "the page's layers are listed");

  // Breadth-first, bounded: find a parent whose children include two layers with the same name,
  // where the second one has children of its own.
  let found = null;
  const queue = top.nodes.filter((node) => node.hasChildren).reverse();
  while (!found && queue.length > 0 && calls < MAX_LIST_CALLS - 6) {
    const parent = queue.shift();
    const children = await list(parent.ref, "children");
    const byName = new Map();
    for (const child of children.nodes) byName.set(child.name, [...(byName.get(child.name) ?? []), child]);
    const twins = [...byName.values()].find((group) => group.length >= 2 && group[1].hasChildren);
    if (twins) found = { parent, children, first: twins[0], second: twins[1] };
    else queue.push(...children.nodes.filter((node) => node.hasChildren));
  }
  assert(found, "the test file has two same-named sibling layers with children (update FIGLOO_E2E_FIGMA_URL if the file changed)");
  const { parent, children, first, second } = found;
  log(`same-name siblings "${first.name}": ${first.ref} and ${second.ref} under ${parent.ref}`);
  assert(first.ref !== second.ref, "same-named siblings have different refs");
  assert(children.nodes.every((node) => node.parentRef === parent.ref), "every listed child names its parent");

  // Climb back up from inside the second twin: the chain must go through the second, not the first.
  const inside = await list(second.ref, "children");
  const child = inside.nodes[0];
  const ancestors = await list(child.ref, "ancestors");
  log(`ancestors of ${child.ref}: ${ancestors.nodes.map((node) => node.ref).join(" > ")}`);
  assert(ancestors.nodes[0]?.ref === second.ref, `the nearest ancestor is the second twin ${second.ref}, not ${first.ref}`);
  assert(ancestors.nodes[1]?.ref === parent.ref, "the next ancestor is their shared parent");
  assert(ancestors.hasMore === false && ancestors.nodes.length === child.depth, "ancestors reach the layer on the page");

  // Paging through the parent's children five at a time returns exactly the full list.
  if (children.total > 5) {
    const paged = [];
    let from = 1;
    let after;
    for (let guard = 0; guard < 20; guard += 1) {
      const pageResult = await list(parent.ref, "children", from, 5, after);
      paged.push(...pageResult.nodes.map((node) => node.ref));
      if (!pageResult.hasMore) break;
      from = pageResult.nextFrom;
      after = pageResult.nodes.at(-1).ref;
    }
    assert(JSON.stringify(paged) === JSON.stringify(children.nodes.map((node) => node.ref)), "paged children match the full listing");
    log(`paged ${paged.length} children five at a time`);
  }

  const after = await expandedRows();
  assert(JSON.stringify(after) === JSON.stringify(before), `the layers panel is left as it was (before ${before.length} expanded, after ${after.length})`);
  log(`PASS after ${calls} list calls; the layers panel is back to its initial state`);
} catch (error) {
  console.error("[explore] FAIL", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
