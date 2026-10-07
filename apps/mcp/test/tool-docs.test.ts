import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { BridgeErrorCodeSchema, ErrorCodeSchema } from "@figloo/protocol";
import type { Bridge } from "../src/bridge.js";
import { ERRORS, SERVER_ERROR_CODES } from "../src/errors.js";
import { createServer } from "../src/server.js";
import { startBridge } from "./helpers.js";

const DOC = resolve(import.meta.dirname, "../../../docs/mcp-tools.md");
/** The tools/list answer the skill evals' mocks show the model, so mocked tools carry their real schemas and descriptions. */
const EVAL_TOOLS = resolve(import.meta.dirname, "../../../tests/skill-eval/evals/mocks/figloo/_tools.json");
/** Codes the server raises itself, next to the protocol's. */

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function typeOf(schema: JsonSchema | undefined): string {
  if (!schema) return "any";
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" or ");
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" or ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "any"];
  return types
    .map((type) => {
      if (type === "array") return `array of ${typeOf(schema.items)}`;
      if (type === "object" && schema.properties) return `object with ${Object.keys(schema.properties).join(", ")}`;
      if (type === "integer" || type === "number") {
        // zod bounds every integer by the safe integer range; only other bounds are worth stating.
        const minimum = schema.minimum !== undefined && schema.minimum > -Number.MAX_SAFE_INTEGER ? schema.minimum : undefined;
        const low = minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
        const high = schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : undefined;
        if (low !== undefined && high !== undefined) return `${type} ${low} to ${high}`;
        if (low !== undefined) return `${type}, at least ${low}`;
      }
      return type;
    })
    .join(" or ");
}

async function listServerTools(bridge: Bridge) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ bridge, version: "docs", log: () => {} }).connect(serverTransport);
  const client = new Client({ name: "docs", version: "0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function renderToolDocs(bridge: Bridge): Promise<string> {
  const tools = await listServerTools(bridge);

  const lines = [
    "# Figloo MCP tools",
    "",
    "Generated from the tools the server registers by `apps/mcp/test/tool-docs.test.ts`; the test fails when this file is out of date. Regenerate it with `pnpm --filter @figloo/mcp docs:tools`.",
    "",
    "Every tool returns its result as JSON text and as `structuredContent`. A failed call returns `isError: true` with the text `{\"error\": {\"code\", \"message\", \"hint\"}}`, where `hint` tells the agent what to do next.",
    "",
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`, "", tool.description ?? "", "");
    const input = tool.inputSchema as JsonSchema;
    const params = Object.entries(input.properties ?? {});
    if (params.length === 0) {
      lines.push("No parameters.", "");
    } else {
      lines.push("| Parameter | Type | Required | Description |", "|---|---|---|---|");
      for (const [name, schema] of params) {
        lines.push(`| \`${name}\` | ${cell(typeOf(schema))} | ${input.required?.includes(name) ? "yes" : "no"} | ${cell(schema.description ?? "")} |`);
      }
      lines.push("");
    }
    const output = tool.outputSchema as JsonSchema | undefined;
    if (output?.properties) {
      lines.push("| Result field | Type |", "|---|---|");
      for (const [name, schema] of Object.entries(output.properties)) lines.push(`| \`${name}\` | ${cell(typeOf(schema))} |`);
      lines.push("");
    }
  }
  const codes = [...new Set([...ErrorCodeSchema.options, ...BridgeErrorCodeSchema.options, ...SERVER_ERROR_CODES])].sort();
  lines.push(
    "## Error codes",
    "",
    "An error result is `{ error: { code, message, hint, category, retry } }`. `retry` says whether calling the same tool again can help: `yes` as it is, perhaps after a short wait; `after_user` once the user did what the hint asks; `no` without a different call first.",
    "",
    "| Code | Category | Retry | Hint |",
    "|---|---|---|---|",
  );
  for (const code of codes) lines.push(`| \`${code}\` | ${ERRORS[code]!.category} | ${ERRORS[code]!.retry} | ${cell(ERRORS[code]!.hint)} |`);
  return `${lines.join("\n")}\n`;
}

let bridge: Bridge | null = null;
afterAll(async () => {
  await bridge?.stop();
});

describe("docs/mcp-tools.md", () => {
  it("describes exactly the tools, parameters, and error codes the server has", async () => {
    bridge = await startBridge();
    const rendered = await renderToolDocs(bridge);
    if (process.env.UPDATE_TOOL_DOCS === "1") writeFileSync(DOC, rendered);
    expect(readFileSync(DOC, "utf8"), "run `pnpm --filter @figloo/mcp docs:tools` to update the file").toBe(rendered);
  });
});

describe("the skill evals' tool list", () => {
  it("lists the tools the server registers, so the mocked tools look real to the model", async () => {
    bridge ??= await startBridge();
    const rendered = `${JSON.stringify({ tools: await listServerTools(bridge) }, null, 2)}\n`;
    if (process.env.UPDATE_TOOL_DOCS === "1") {
      mkdirSync(dirname(EVAL_TOOLS), { recursive: true });
      writeFileSync(EVAL_TOOLS, rendered);
    }
    expect(readFileSync(EVAL_TOOLS, "utf8"), "run `pnpm --filter @figloo/mcp docs:tools` to update the file").toBe(rendered);
  });
});
