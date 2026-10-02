// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Explorer } from "../src/adapter/ops.js";

/** The repository root, found from the working directory; URL-based paths do not work under happy-dom. */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("repository root not found");
    dir = up;
  }
  return dir;
}

const FIXTURE = readFileSync(join(repoRoot(), "tests/fixtures/figma-pages-list.html"), "utf8");
const FILE_URL = "https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Sample-App?node-id=873-45095";
const ALL_PAGES = Array.from({ length: 20 }, (_, i) => `Page ${i + 1}`);
const ROW_HEIGHT = 32;

beforeEach(() => {
  document.documentElement.innerHTML = new DOMParser().parseFromString(FIXTURE, "text/html").documentElement.innerHTML;
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(FILE_URL);
});

const grid = () => document.querySelector('[role="grid"]')!;
const listPages = () => new Explorer("page-1", document, window).listPages();
const names = (result: { pages: { name: string }[] }) => result.pages.map((page) => page.name);

/** Gives the list the layout it had in Arc, which happy-dom does not compute: 32 px rows in a list that scrolls through `rows` of them. */
function layOut(rows: number): void {
  const scroller = document.querySelector('[style*="overflow-y: scroll"]')!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => rows * ROW_HEIGHT });
  for (const row of document.querySelectorAll('[role="row"]')) {
    Object.defineProperty(row, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 240, ROW_HEIGHT) });
  }
}

describe("list_pages on the captured pages list", () => {
  it("reads every page and the one shown", async () => {
    layOut(20);
    const result = await listPages();
    expect(names(result)).toEqual(ALL_PAGES);
    expect(result.pages.filter((page) => page.current).map((page) => page.name)).toEqual(["Page 3"]);
    expect(result).toMatchObject({ fileKey: "AbCdEfGhIjKlMnOpQrStUv", complete: true });
  });

  it("waits for pages Figma draws after the first read instead of reporting the first 8", async () => {
    // In Arc on 2026-10-02, a first read returned 8 of the file's 20 pages and later reads all 20.
    const late = [...grid().children].slice(8);
    for (const row of late) row.remove();
    setTimeout(() => grid().append(...late), 60);
    const result = await listPages();
    expect(names(result)).toEqual(ALL_PAGES);
    expect(result.complete).toBe(true);
  });

  it("reports the list as incomplete when it scrolls through more rows than it has drawn", async () => {
    layOut(20);
    for (const row of [...grid().children].slice(8)) row.remove();
    const result = await listPages();
    expect(names(result)).toEqual(ALL_PAGES.slice(0, 8));
    expect(result.complete).toBe(false);
  });

  it("reports the list as incomplete when a row of the grid has no page drawn in it", async () => {
    grid().children[10]!.replaceChildren();
    const result = await listPages();
    expect(names(result)).toEqual(ALL_PAGES.filter((name) => name !== "Page 11"));
    expect(result.complete).toBe(false);
  });

  it("reports the list as incomplete when it is still changing after the wait", async () => {
    const last = grid().lastElementChild!;
    const timer = setInterval(() => (last.isConnected ? last.remove() : grid().append(last)), 50);
    try {
      expect((await listPages()).complete).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it("says the pages list is not shown when Figma has drawn none of it", async () => {
    document.body.replaceChildren();
    await expect(listPages()).rejects.toMatchObject({ code: "UI_NOT_READY" });
  });
});
