import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { sessionLabel } from "@figloo/protocol";
import { HolderInfoSchema } from "./bridge.js";
import { DEFAULT_PORT, configDir } from "./config.js";

/** One line of the report: fine, worth knowing, or a problem that keeps Figloo from working. */
export interface DoctorCheck {
  status: "ok" | "note" | "problem";
  title: string;
  fix?: string;
}

export interface DoctorOptions {
  version: string;
  /** The config folder; ~/.figloo or FIGLOO_CONFIG_DIR by default. */
  dir?: string;
  nodeVersion?: string;
  /** FIGLOO_PORT, which overrides the config file's port. */
  portOverride?: string;
}

const MIN_NODE_MAJOR = 24;
const HOLDER_TIMEOUT_MS = 2_000;
const PAIR = "`figloo-mcp pair`";

/**
 * Checks what can keep the extension from connecting, without starting the bridge or taking the
 * port from a session: Node.js, the config file and its pairing token, and who holds the port.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const node = options.nodeVersion ?? process.versions.node;
  checks.push(
    Number.parseInt(node, 10) >= MIN_NODE_MAJOR
      ? { status: "ok", title: `Node.js ${node}` }
      : { status: "problem", title: `Node.js ${node} is older than the ${MIN_NODE_MAJOR} the MCP server needs`, fix: `Install Node.js ${MIN_NODE_MAJOR} or newer.` },
  );

  const dir = options.dir ?? configDir();
  const path = join(dir, "config.json");
  let stored: { token?: unknown; port?: unknown } | null = null;
  if (!existsSync(path)) {
    checks.push({ status: "problem", title: `No config file at ${path}`, fix: `Run ${PAIR}, or \`node figloo-mcp-<version>.mjs pair\` with the release file: it creates the file and prints the token and port for the extension's options page.` });
  } else {
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown; port?: unknown };
    } catch {
      checks.push({ status: "problem", title: `${path} is not valid JSON`, fix: `Fix it, or delete it and run ${PAIR} again.` });
    }
  }
  if (stored) {
    const token = typeof stored.token === "string" && stored.token.length > 0;
    checks.push(token ? { status: "ok", title: `Config ${path}, with a pairing token` } : { status: "problem", title: `${path} has no pairing token`, fix: `Run ${PAIR}, then paste the token into the extension's options page.` });
    for (const [what, at, mode] of [
      ["The config file", path, 0o600],
      ["The config folder", dir, 0o700],
    ] as const) {
      const actual = statSync(at).mode & 0o777;
      if (actual & 0o077) checks.push({ status: "note", title: `${what} can be read by other users of this computer (mode ${actual.toString(8)})`, fix: `chmod ${mode.toString(8)} ${at}` });
    }
  }

  const port = options.portOverride ? Number(options.portOverride) : typeof stored?.port === "number" ? stored.port : DEFAULT_PORT;
  checks.push(...(await portChecks(port, typeof stored?.token === "string" ? stored.token : "", options.version)));
  return checks;
}

async function portChecks(port: number, token: string, version: string): Promise<DoctorCheck[]> {
  const answer = await askHolder(port, token);
  if (answer === "free") return [{ status: "ok", title: `Port ${port} is free: no agent session runs Figloo right now; the first one listens there once it starts` }];
  if (answer === "unreachable") {
    return [{ status: "problem", title: `Port ${port} is held by a program that is not Figloo`, fix: `Set FIGLOO_PORT, or port in the config file, to a free port, and the same port in the extension's options page.` }];
  }
  if (answer.status === 401) {
    return [{ status: "problem", title: `A Figloo server on port ${port} rejected this config's pairing token`, fix: "That session uses another config folder: check FIGLOO_CONFIG_DIR, or restart that session." }];
  }
  if (answer.status === 404) {
    return [{ status: "problem", title: `Port ${port} is held by Figloo 0.1.0, which cannot hand the extension over to other sessions`, fix: "Close or restart the agent session that runs it." }];
  }
  const holder = HolderInfoSchema.safeParse(answer.body);
  if (answer.status !== 200 || !holder.success) {
    return [{ status: "problem", title: `Port ${port} is held by a program that is not Figloo`, fix: `Set FIGLOO_PORT, or port in the config file, to a free port, and the same port in the extension's options page.` }];
  }
  const { session, extensionVersion, tabs } = holder.data;
  const checks: DoctorCheck[] = [{ status: "ok", title: `Port ${port}: Figloo ${session.serverVersion} serves ${sessionLabel(session)}` }];
  if (session.serverVersion !== version) {
    checks.push({ status: "note", title: `That session runs Figloo ${session.serverVersion}, and this is ${version}`, fix: "Start a new agent session after updating, so the new server runs." });
  }
  if (extensionVersion === undefined) {
    checks.push({ status: "note", title: `Figloo ${session.serverVersion} does not say whether an extension is connected to it`, fix: "Ask the agent in that session to call get_status." });
  } else if (extensionVersion === null) {
    checks.push({
      status: "problem",
      title: "No Figloo extension is connected to it",
      fix: `Load the extension in the browser and paste the token and port that ${PAIR} prints into its options page, which also shows the last connection error.`,
    });
  } else {
    checks.push({ status: "ok", title: `Extension ${extensionVersion} connected, with ${tabs.length} Figma design tab${tabs.length === 1 ? "" : "s"} open` });
    if (extensionVersion !== session.serverVersion) checks.push({ status: "note", title: `The extension is ${extensionVersion} and the server ${session.serverVersion}`, fix: "Update both to the same release." });
  }
  return checks;
}

type HolderAnswer = { status: number; body: unknown } | "free" | "unreachable";

/** Asks whoever holds the port who it is, the way another Figloo server would. */
function askHolder(port: number, token: string): Promise<HolderAnswer> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/holder", agent: false, headers: { authorization: `Bearer ${token}` }, timeout: HOLDER_TIMEOUT_MS }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: not a Figloo server.
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED" ? "free" : "unreachable"));
    req.end();
  });
}

export function formatDoctor(version: string, checks: DoctorCheck[]): string {
  const mark = { ok: "✓", note: "!", problem: "✗" } as const;
  const lines = [`Figloo doctor ${version}`, ""];
  for (const check of checks) {
    lines.push(`${mark[check.status]} ${check.title}`);
    if (check.fix && check.status !== "ok") lines.push(`    ${check.fix}`);
  }
  lines.push("", checks.some((check) => check.status === "problem") ? "Fix the problems above, then run doctor again." : "Next: in an agent session, ask the agent to call get_status, which checks the extension and the Figma tab.");
  return `${lines.join("\n")}\n`;
}
