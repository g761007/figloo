import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("get_status", () => {
  it("reports DISCONNECTED while no extension bridge exists", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "get_status" });

    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "DISCONNECTED" }) }]);
    await client.close();
  });
});
