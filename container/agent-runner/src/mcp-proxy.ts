/**
 * MCP Proxy — sits between agent and upstream MCP server.
 * Enforces tool allowlists and param pinning per ProxyConfig.
 *
 * Reads config from MCP_PROXY_CONFIG env var (JSON).
 * Starts as stdio MCP server (for agent SDK) and connects
 * to the upstream MCP server via stdio (spawn) or HTTP (bridge).
 *
 * Security model:
 * - Only tools with `allow: true` in rules are visible to the agent
 * - Pinned params are injected on every call — agent can't override them
 * - Pinned params are hidden from tool schemas so agent doesn't see them
 * - Tools not in rules are blocked (secure by default)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface ToolRule {
  allow: boolean;
  pinnedParams?: Record<string, string>;
}

interface ProxyConfig {
  upstream: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** HTTP URL for connecting to a host-side MCP bridge */
    url?: string;
  };
  rules: Record<string, ToolRule>;
}

// --- Parse config ---

const configJson = process.env.MCP_PROXY_CONFIG;
if (!configJson) {
  process.stderr.write('MCP_PROXY_CONFIG env var is required\n');
  process.exit(1);
}

const config: ProxyConfig = JSON.parse(configJson);

// --- Connect to upstream MCP server ---

const upstream = new Client({ name: 'nonnaclaw-mcp-proxy', version: '1.0.0' });

if (config.upstream.url) {
  // HTTP mode: connect to host-side MCP bridge
  const httpTransport = new StreamableHTTPClientTransport(
    new URL(config.upstream.url),
  );
  await upstream.connect(httpTransport);
} else if (config.upstream.command) {
  // Stdio mode: spawn upstream as child process
  const stdioTransport = new StdioClientTransport({
    command: config.upstream.command,
    args: config.upstream.args,
    env: { ...process.env, ...config.upstream.env } as Record<string, string>,
  });
  await upstream.connect(stdioTransport);
} else {
  process.stderr.write('ProxyConfig.upstream must have either url or command\n');
  process.exit(1);
}

// Fetch upstream tool list once at startup
const { tools: upstreamTools } = await upstream.listTools();

// --- Create proxy server ---

const proxy = new Server(
  { name: 'nanoclaw-mcp-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// tools/list — return only allowed tools, with pinned params hidden from schemas
proxy.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = upstreamTools
    .filter((tool) => config.rules[tool.name]?.allow === true)
    .map((tool) => {
      const pinnedKeys = new Set(
        Object.keys(config.rules[tool.name]?.pinnedParams || {}),
      );
      if (pinnedKeys.size === 0) return tool;

      // Remove pinned params from the schema so agent doesn't see them
      const schema = {
        ...(tool.inputSchema || { type: 'object' as const }),
      } as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };

      if (schema.properties) {
        const props = { ...schema.properties };
        for (const key of pinnedKeys) delete props[key];
        schema.properties = props;
      }

      if (schema.required) {
        schema.required = schema.required.filter((r) => !pinnedKeys.has(r));
      }

      return { ...tool, inputSchema: schema };
    });

  return { tools };
});

// tools/call — check allowlist, inject pinned params, forward to upstream
proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const rule = config.rules[name];

  if (!rule?.allow) {
    return {
      content: [
        { type: 'text' as const, text: `Tool "${name}" is not allowed.` },
      ],
      isError: true,
    };
  }

  // Pinned params override anything the agent provides
  const mergedArgs = {
    ...(args || {}),
    ...(rule.pinnedParams || {}),
  };

  return await upstream.callTool({ name, arguments: mergedArgs });
});

// --- Start stdio transport (facing agent SDK) ---

const transport = new StdioServerTransport();
await proxy.connect(transport);
