/**
 * MCP Forwarder — dumb stdio-to-HTTP adapter.
 *
 * Zero filtering. All scope enforcement happens on the host side
 * in mcp-bridge.ts. This just bridges the Agent SDK's stdio MCP
 * interface to the host's HTTP endpoint.
 *
 * Reads MCP_UPSTREAM_URL env var (e.g., "http://host.docker.internal:19700/mcp/groupName").
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const upstreamUrl = process.env.MCP_UPSTREAM_URL;
if (!upstreamUrl) {
  process.stderr.write('MCP_UPSTREAM_URL env var is required\n');
  process.exit(1);
}

// Connect to host-side MCP bridge
const upstream = new Client({
  name: 'nonnaclaw-mcp-forwarder',
  version: '1.0.0',
});
const httpTransport = new StreamableHTTPClientTransport(new URL(upstreamUrl));
await upstream.connect(httpTransport);

// Cache tool list (already filtered by host)
const { tools: cachedTools } = await upstream.listTools();

// Expose stdio MCP server for Agent SDK
const server = new Server(
  { name: 'nonnaclaw-mcp-forwarder', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: cachedTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await upstream.callTool({ name, arguments: args });
});

const transport = new StdioServerTransport();
await server.connect(transport);
