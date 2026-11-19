// Minimal stdio MCP server for tests: one "echo" tool and one "fail" tool. No SDK, no network.
import readline from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const tools = [
  { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  else if (method === "tools/list") send({ id, result: { tools } });
  else if (method === "tools/call" && params.name === "echo")
    send({
      id,
      result: {
        content: [
          {
            type: "text",
            text: `echo: ${params.arguments.text} (${process.env.ECHO_PREFIX ?? "no prefix"}, secret ${process.env.AMUSE_TEST_SECRET ? "visible" : "hidden"})`,
          },
        ],
      },
    });
  else if (method === "tools/call") send({ id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
  else if (method === "ping") send({ id, result: {} });
  else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
