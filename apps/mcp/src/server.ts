import type { ConnectionStatus } from "@figloo/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "figloo", version: "0.0.1" });

  server.registerTool(
    "get_status",
    { description: "Report the connection status of the Figloo extension." },
    async () => {
      // Placeholder until the extension bridge exists.
      const status: ConnectionStatus = "DISCONNECTED";
      return { content: [{ type: "text", text: JSON.stringify({ status }) }] };
    },
  );

  return server;
}
