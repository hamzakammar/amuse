import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connectMcpServer, mcpResultToOutput, mcpToolDefs, mcpToolName, parseMcpConfig } from "../src/agent/mcp";
import type { ProposedAction } from "../src/agent/sentinel";
import type { ToolContext } from "../src/agent/tools/types";

const ECHO_SERVER = path.join(import.meta.dirname, "fixtures/mcp-echo-server.mjs");

function ctx(): ToolContext {
  return {
    userId: "test",
    runId: 7,
    chatId: 3,
    tz: "UTC",
    trigger: "user",
    depth: 0,
    setStatus: async () => {},
    activity: async () => {},
    addParts: () => {},
    usage: async () => {},
    signal: { stopped: false },
  };
}

describe("MCP config", () => {
  it("parses stdio and streamable HTTP servers and expands ${NAME}", () => {
    const servers = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          files: { command: "node", args: ["server.js", "${ROOT}"], env: { TOKEN: "${TOKEN}" }, readOnly: true },
          notes: { url: "https://notes.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, timeoutMs: 5000 },
        },
      }),
      { ROOT: "/data", TOKEN: "t0k" },
    );
    expect(servers.files).toEqual({ command: "node", args: ["server.js", "/data"], env: { TOKEN: "t0k" }, readOnly: true, timeoutMs: undefined });
    expect(servers.notes).toEqual({ url: "https://notes.example/mcp", headers: { Authorization: "Bearer t0k" }, readOnly: false, timeoutMs: 5000 });
  });
  it("rejects ambiguous, malformed and unsafe entries", () => {
    const bad =
      (s: unknown, env = {}) =>
      () =>
        parseMcpConfig(JSON.stringify(s), env);
    expect(bad({})).toThrow(/mcpServers/);
    expect(bad({ mcpServers: { x: {} } })).toThrow(/exactly one/);
    expect(bad({ mcpServers: { x: { command: "a", url: "https://b" } } })).toThrow(/exactly one/);
    expect(bad({ mcpServers: { "bad name": { command: "a" } } })).toThrow(/server names/);
    expect(bad({ mcpServers: { x: { command: "a", args: "b" } } })).toThrow(/args/);
    expect(bad({ mcpServers: { x: { command: "a", headers: {} } } })).toThrow(/headers/);
    expect(bad({ mcpServers: { x: { url: "https://b", env: {} } } })).toThrow(/command/);
    expect(bad({ mcpServers: { x: { url: "file:///etc/passwd" } } })).toThrow(/http/);
    expect(bad({ mcpServers: { x: { url: "https://b", headers: { A: "${MISSING}" } } } })).toThrow(/MISSING/);
    expect(bad({ mcpServers: { x: { command: "a", timeoutMs: -1 } } })).toThrow(/timeoutMs/);
  });
});

describe("MCP tool names and results", () => {
  it("namespaces tool names within OpenAI's function-name rules", () => {
    expect(mcpToolName("files", "read_file")).toBe("mcp__files__read_file");
    expect(mcpToolName("files", "search.v2/all")).toBe("mcp__files__search_v2_all");
    expect(mcpToolName("files", "x".repeat(100))).toHaveLength(64);
  });
  it("returns text as untrusted data, errors as errors, and notes unshown content", () => {
    expect(
      mcpResultToOutput({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({ untrusted_data: true, result: "a\nb" });
    expect(mcpResultToOutput({ content: [{ type: "text", text: "nope" }], isError: true })).toEqual({ error: "nope" });
    expect(mcpResultToOutput({ content: [], structuredContent: { n: 1 } })).toEqual({ untrusted_data: true, result: { n: 1 } });
    expect(mcpResultToOutput({ content: [{ type: "image", data: "", mimeType: "image/png" }] }).note).toMatch(/image/);
  });
});

describe("MCP tools and the sentinel", () => {
  const tools = [{ name: "search", description: "Search notes", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];

  it("asks before every call as a write, and does not call a denied tool", async () => {
    const actions: ProposedAction[] = [];
    const call = vi.fn();
    const [def] = mcpToolDefs("notes", {}, tools, call, { check: async (a) => (actions.push(a), "deny"), markUntrustedRead: () => {} });
    expect(def!.name).toBe("mcp__notes__search");
    expect(def!.description).toContain('[MCP server "notes"] Search notes');
    expect(await def!.run({ q: "x" }, ctx())).toEqual({ error: "The person denied search (notes)." });
    expect(call).not.toHaveBeenCalled();
    expect(actions[0]).toMatchObject({
      toolName: "mcp__notes__search",
      actionClass: "write",
      target: "mcp:notes",
      runId: 7,
      details: { arguments: { q: "x" } },
    });
  });
  it("treats a readOnly server's calls as reads and marks the run as having read untrusted data", async () => {
    const actions: ProposedAction[] = [];
    const untrusted: number[] = [];
    const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "hit" }] }));
    const [def] = mcpToolDefs("notes", { readOnly: true }, tools, call, {
      check: async (a) => (actions.push(a), "allow"),
      markUntrustedRead: (id) => untrusted.push(id),
    });
    expect(await def!.run({ q: "x" }, ctx())).toEqual({ untrusted_data: true, result: "hit" });
    expect(call).toHaveBeenCalledWith("search", { q: "x" });
    expect(actions[0]!.actionClass).toBe("read");
    expect(untrusted).toEqual([7]);
  });
  it("reports a server failure as a tool error", async () => {
    const [def] = mcpToolDefs("notes", {}, tools, async () => Promise.reject(new Error("gone")), { check: async () => "allow", markUntrustedRead: () => {} });
    expect(await def!.run({}, ctx())).toEqual({ error: 'MCP server "notes" failed: gone' });
  });
});

describe("MCP over stdio", () => {
  it("discovers and calls a real stdio server, passing only the configured environment", async () => {
    process.env.AMUSE_TEST_SECRET = "must-not-leak";
    const server = await connectMcpServer({ command: process.execPath, args: [ECHO_SERVER], env: { ECHO_PREFIX: "configured" } });
    try {
      expect(server.tools.map((t) => t.name)).toEqual(["echo", "fail"]);
      const defs = mcpToolDefs("echo", {}, server.tools, server.call, { check: async () => "allow", markUntrustedRead: () => {} });
      expect(await defs[0]!.run({ text: "hi" }, ctx())).toEqual({ untrusted_data: true, result: "echo: hi (configured, secret hidden)" });
      expect(await defs[1]!.run({}, ctx())).toEqual({ error: "boom" });
    } finally {
      await server.close();
      delete process.env.AMUSE_TEST_SECRET;
    }
  });
});
