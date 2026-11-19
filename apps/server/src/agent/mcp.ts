import fs from "node:fs";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { logger } from "../lib/logger";
import { check, markUntrustedRead, type ProposedAction } from "./sentinel";
import type { ToolDef } from "./tools/types";

/**
 * Optional MCP servers. Off unless AMUSE_MCP_CONFIG points at a JSON file in the common `mcpServers` shape:
 *
 *   { "mcpServers": {
 *       "files": { "command": "node", "args": ["server.js"], "env": { "ROOT": "/data" } },
 *       "notes": { "url": "https://notes.example/mcp", "headers": { "Authorization": "Bearer ${NOTES_TOKEN}" } } } }
 *
 * Each server's tools are discovered at startup and offered to the agent as mcp__<server>__<tool>. Every call goes
 * through the sentinel like any other action: as "write" (ask, with once / task / always) unless the owner marks the
 * server "readOnly": true, which makes its calls "read". Results are untrusted data, like web pages.
 * String values may reference environment variables as ${NAME}, so tokens can stay out of the file.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type CallFn = (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
interface McpDeps {
  check: (a: ProposedAction) => Promise<"allow" | "deny">;
  markUntrustedRead: (runId: number) => void;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_TIMEOUT_MS = 60_000;

function expand(value: string, env: NodeJS.ProcessEnv, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`${where} uses \${${name}}, which is not set`);
    return v;
  });
}

function stringMap(value: unknown, env: NodeJS.ProcessEnv, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object of strings`);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (typeof v !== "string") throw new Error(`${where}.${k} must be a string`);
      return [k, expand(v, env, `${where}.${k}`)];
    }),
  );
}

/** Validates an MCP config file and expands ${NAME} references. Throws with the offending field on bad input. */
export function parseMcpConfig(text: string, env: NodeJS.ProcessEnv = process.env): Record<string, McpServerConfig> {
  const raw = JSON.parse(text);
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error('MCP config needs an "mcpServers" object');
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(servers as Record<string, any>)) {
    const where = `mcpServers.${name}`;
    if (!SERVER_NAME.test(name)) throw new Error(`${where}: server names may use letters, digits, _ and - (at most 32)`);
    if (!s || typeof s !== "object") throw new Error(`${where} must be an object`);
    if (!!s.command === !!s.url) throw new Error(`${where} needs exactly one of "command" (stdio) or "url" (streamable HTTP)`);
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a: unknown) => typeof a !== "string")))
      throw new Error(`${where}.args must be an array of strings`);
    if (s.timeoutMs !== undefined && !(Number.isFinite(s.timeoutMs) && s.timeoutMs > 0)) throw new Error(`${where}.timeoutMs must be a positive number`);
    const cfg: McpServerConfig = { readOnly: s.readOnly === true, timeoutMs: s.timeoutMs };
    if (s.command) {
      if (s.headers !== undefined) throw new Error(`${where}: "headers" only applies to "url" servers`);
      cfg.command = expand(String(s.command), env, `${where}.command`);
      cfg.args = (s.args ?? []).map((a: string, i: number) => expand(a, env, `${where}.args[${i}]`));
      cfg.env = stringMap(s.env, env, `${where}.env`);
      if (s.cwd !== undefined) cfg.cwd = expand(String(s.cwd), env, `${where}.cwd`);
    } else {
      if (s.args !== undefined || s.env !== undefined || s.cwd !== undefined)
        throw new Error(`${where}: "args", "env" and "cwd" only apply to "command" servers`);
      const url = new URL(expand(String(s.url), env, `${where}.url`));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${where}.url must be http(s)`);
      cfg.url = url.href;
      cfg.headers = stringMap(s.headers, env, `${where}.headers`);
    }
    out[name] = cfg;
  }
  return out;
}

/** mcp__<server>__<tool>, limited to the characters and length OpenAI accepts for function names. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

/** Turns an MCP tool result into the JSON the agent sees. */
export function mcpResultToOutput(r: CallToolResult): Record<string, unknown> {
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
  if (r.isError) return { error: text || "The MCP tool reported an error." };
  const other = [...new Set(content.filter((c) => c.type !== "text").map((c) => c.type))];
  return {
    untrusted_data: true,
    result: text || (r.structuredContent ?? null),
    ...(other.length ? { note: `Non-text content (${other.join(", ")}) is not shown.` } : {}),
  };
}

/** Wraps one server's tools as Amuse tools that ask the sentinel before every call. */
export function mcpToolDefs(server: string, cfg: McpServerConfig, tools: McpTool[], call: CallFn, deps: McpDeps = { check, markUntrustedRead }): ToolDef[] {
  const seen = new Set<string>();
  const defs: ToolDef[] = [];
  for (const tool of tools) {
    const name = mcpToolName(server, tool.name);
    if (seen.has(name)) {
      logger.warn({ server, tool: tool.name }, "Skipping MCP tool whose name collides after namespacing");
      continue;
    }
    seen.add(name);
    const label = tool.title || tool.name;
    defs.push({
      name,
      skill: server,
      status: `Using ${server}`,
      description: `[MCP server "${server}"] ${tool.description ?? label}`.slice(0, 1000),
      parameters: { type: "object", properties: {}, ...(tool.inputSchema ?? {}) },
      async run(args, ctx) {
        const decision = await deps.check({
          userId: ctx.userId,
          runId: ctx.runId,
          chatId: ctx.chatId,
          toolName: name,
          actionClass: cfg.readOnly ? "read" : "write",
          target: `mcp:${server}`,
          purpose: `Use "${label}" from the ${server} MCP server`,
          details: { arguments: args ?? {} },
        });
        if (decision === "deny") return { error: `The person denied ${label} (${server}).` };
        await ctx.setStatus(`Using ${server}`);
        let result: CallToolResult;
        try {
          result = await call(tool.name, args ?? {});
        } catch (e) {
          return { error: `MCP server "${server}" failed: ${(e as Error).message}` };
        }
        deps.markUntrustedRead(ctx.runId);
        await ctx.activity("tool", `Used ${label} (${server})`, {}, server);
        return mcpResultToOutput(result);
      },
    });
  }
  return defs;
}

function transportFor(cfg: McpServerConfig): Transport {
  if (cfg.command) {
    // Only the SDK's safe default variables (PATH, HOME, ...) plus the configured env reach the server, never Amuse's keys.
    return new StdioClientTransport({ command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: { ...getDefaultEnvironment(), ...cfg.env } });
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });
}

/** Connects one server and lists its tools. */
export async function connectMcpServer(cfg: McpServerConfig): Promise<{ tools: McpTool[]; call: CallFn; close: () => Promise<void> }> {
  const client = new Client({ name: "amuse", version: "0.1.0" });
  await client.connect(transportFor(cfg));
  const { tools } = await client.listTools();
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    tools: tools as McpTool[],
    call: (tool, args) => client.callTool({ name: tool, arguments: args }, { timeout }) as Promise<CallToolResult>,
    close: () => client.close(),
  };
}

/** Reads AMUSE_MCP_CONFIG, connects every server and returns their tools. A server that fails to start is skipped. */
export async function startMcp(file = process.env.AMUSE_MCP_CONFIG): Promise<ToolDef[]> {
  if (!file) return [];
  const servers = parseMcpConfig(fs.readFileSync(file, "utf8"));
  const defs: ToolDef[] = [];
  for (const [server, cfg] of Object.entries(servers)) {
    try {
      const { tools, call } = await connectMcpServer(cfg);
      defs.push(...mcpToolDefs(server, cfg, tools, call));
      logger.info({ server, tools: tools.map((t) => t.name), readOnly: cfg.readOnly }, "MCP server connected");
    } catch (err) {
      logger.warn({ err, server }, "MCP server unavailable; its tools are not offered");
    }
  }
  return defs;
}
