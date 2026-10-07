import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Bridge } from "../src/bridge.js";
import { formatDoctor, runDoctor } from "../src/doctor.js";
import { TOKEN, pairFakeExtension, startBridge } from "./helpers.js";

const dirs: string[] = [];
const bridges: Bridge[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A config folder as `pair` leaves it: private, with a token and a port. */
function configFolder(config: Record<string, unknown> | null = { token: TOKEN }): string {
  const dir = mkdtempSync(join(tmpdir(), "figloo-doctor-"));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function httpServer(status: number, body: string): Promise<number> {
  const server = createServer((_req, res) => res.writeHead(status).end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const statuses = (checks: Awaited<ReturnType<typeof runDoctor>>) => checks.map((check) => `${check.status} ${check.title}`);

describe("figloo-mcp doctor", () => {
  it("passes a paired setup while no agent session runs Figloo", async () => {
    const dir = configFolder();
    const port = await freePort();
    const checks = await runDoctor({ version: "0.5.0", dir, nodeVersion: "24.15.0", portOverride: String(port) });
    expect(statuses(checks)).toEqual(["ok Node.js 24.15.0", `ok Config ${join(dir, "config.json")}, with a pairing token`, `ok Port ${port} is free: no agent session runs Figloo right now; the first one listens there once it starts`]);
    expect(formatDoctor("0.5.0", checks)).toMatch(/Next: in an agent session, ask the agent to call get_status/);
  });

  it("explains an old Node.js and a missing config with the commands that fix them, without creating the config", async () => {
    const dir = configFolder(null);
    const checks = await runDoctor({ version: "0.5.0", dir, nodeVersion: "20.11.0", portOverride: String(await freePort()) });
    expect(checks.filter((check) => check.status === "problem").map((check) => check.fix)).toEqual([
      "Install Node.js 24 or newer.",
      expect.stringMatching(/^Run `figloo-mcp pair`.*prints the token and port/),
    ]);
    expect(formatDoctor("0.5.0", checks)).toMatch(/✗ No config file at .*\n {4}Run `figloo-mcp pair`[\s\S]*Fix the problems above/);
  });

  it("notes a config file other users can read", async () => {
    const dir = configFolder();
    chmodSync(join(dir, "config.json"), 0o644);
    const checks = await runDoctor({ version: "0.5.0", dir, nodeVersion: "24.15.0", portOverride: String(await freePort()) });
    expect(checks).toContainEqual({ status: "note", title: "The config file can be read by other users of this computer (mode 644)", fix: `chmod 600 ${join(dir, "config.json")}` });
  });

  it("names the session that holds the port and whether an extension is connected to it", async () => {
    const bridge = await startBridge({ serverVersion: "0.5.0" });
    bridges.push(bridge);
    const dir = configFolder({ token: TOKEN, port: bridge.port });
    let checks = await runDoctor({ version: "0.5.0", dir, nodeVersion: "24.15.0" });
    expect(statuses(checks).slice(2)).toEqual([`ok Port ${bridge.port}: Figloo 0.5.0 serves test (started ${new Date(bridge.session.startedAt).toTimeString().slice(0, 5)})`, "problem No Figloo extension is connected to it"]);

    const ext = await pairFakeExtension(bridge.port);
    checks = await runDoctor({ version: "0.5.0", dir, nodeVersion: "24.15.0" });
    expect(statuses(checks).slice(3)).toEqual(["ok Extension 0.0.1 connected, with 0 Figma design tabs open", "note The extension is 0.0.1 and the server 0.5.0"]);
    ext.ws.close();
  });

  it("does not claim that no extension is connected to a holder before 0.5.0, which does not say", async () => {
    const holder = { session: { client: "Claude Code", project: "shop", pid: 1, startedAt: 0, serverVersion: "0.4.0" }, busy: false, lastActivityAt: null, tabs: [] };
    const checks = await runDoctor({ version: "0.5.0", dir: configFolder({ token: TOKEN, port: await httpServer(200, JSON.stringify(holder)) }), nodeVersion: "24.15.0" });
    expect(checks.map((check) => check.status)).not.toContain("problem");
    expect(checks.at(-1)).toMatchObject({ status: "note", title: "Figloo 0.4.0 does not say whether an extension is connected to it" });
  });

  it("tells a server with another config, an old Figloo, and another program apart", async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const wrongToken = await runDoctor({ version: "0.5.0", dir: configFolder({ token: "other-token", port: bridge.port }), nodeVersion: "24.15.0" });
    expect(wrongToken.at(-1)).toMatchObject({ status: "problem", title: expect.stringMatching(/rejected this config's pairing token/) });

    const old = await runDoctor({ version: "0.5.0", dir: configFolder({ token: TOKEN, port: await httpServer(404, "") }), nodeVersion: "24.15.0" });
    expect(old.at(-1)).toMatchObject({ status: "problem", title: expect.stringMatching(/Figloo 0\.1\.0, which cannot hand/) });

    const other = await runDoctor({ version: "0.5.0", dir: configFolder({ token: TOKEN, port: await httpServer(200, "<html></html>") }), nodeVersion: "24.15.0" });
    expect(other.at(-1)).toMatchObject({ status: "problem", title: expect.stringMatching(/not Figloo/), fix: expect.stringMatching(/FIGLOO_PORT/) });
  });
});
