/**
 * MCP Bridge — Host-side manager for persistent MCP servers.
 *
 * For each skill with an `mcp` field:
 * 1. Spawns the MCP server as a child process (stdio)
 * 2. Connects as an MCP client
 * 3. Exposes an HTTP bridge (Streamable HTTP) on localhost
 * 4. Optionally polls for inbound messages
 *
 * Container-side proxies connect to the HTTP endpoint
 * instead of spawning their own upstream MCP server.
 */
import { ChildProcess, spawn } from 'child_process';
import http from 'http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  MCP_BASE_PORT,
  MCP_DEFAULT_POLL_INTERVAL,
  MCP_HEALTH_INTERVAL,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { InboxEvent, LoadedSkill } from './types.js';

/**
 * Return an ISO-8601-ish string in local time with UTC offset,
 * e.g. "2026-02-28 22:09:45-08:00". Matches the format many
 * SQLite-backed MCP servers use for timestamp storage/comparison.
 */
function localISOString(date?: Date): string {
  const d = date ?? new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd} ${h}:${m}:${s}${sign}${hh}:${mm}`;
}

interface BridgeEntry {
  skillName: string;
  port: number;
  upstream: Client;
  upstreamTransport: StdioClientTransport;
  mcpServer: Server;
  httpTransport: StreamableHTTPServerTransport;
  httpServer: http.Server;
  childProcess?: ChildProcess;
  pollTimer?: ReturnType<typeof setInterval>;
  healthTimer?: ReturnType<typeof setInterval>;
  healthy: boolean;
}

const bridges = new Map<string, BridgeEntry>();

export interface McpBridgeConfig {
  skills: LoadedSkill[];
  basePort?: number;
  onInboxEvent?: (event: InboxEvent) => void;
}

/**
 * Start MCP bridges for all skills that declare an `mcp` field.
 * Each skill gets a persistent upstream connection + HTTP endpoint.
 */
export async function startMcpBridges(config: McpBridgeConfig): Promise<void> {
  const basePort = config.basePort ?? MCP_BASE_PORT;
  let portOffset = 0;

  for (const skill of config.skills) {
    if (!skill.manifest.mcp) continue;

    const port = basePort + portOffset++;
    try {
      await startBridge(skill, port, config.onInboxEvent);
      logger.info({ skill: skill.manifest.name, port }, 'MCP bridge started');
    } catch (err) {
      logger.error(
        { skill: skill.manifest.name, port, err },
        'Failed to start MCP bridge',
      );
    }
  }
}

/**
 * Stop all MCP bridges and clean up resources.
 */
export async function stopMcpBridges(): Promise<void> {
  for (const [name, entry] of bridges) {
    logger.debug({ skill: name }, 'Stopping MCP bridge');

    if (entry.pollTimer) clearInterval(entry.pollTimer);
    if (entry.healthTimer) clearInterval(entry.healthTimer);

    try {
      entry.httpServer.close();
    } catch {
      /* best effort */
    }

    try {
      await entry.httpTransport.close();
    } catch {
      /* best effort */
    }

    try {
      await entry.upstream.close();
    } catch {
      /* best effort */
    }

    if (entry.childProcess) {
      entry.childProcess.kill('SIGTERM');
    }
  }
  bridges.clear();
}

/**
 * Get the HTTP port for a running skill bridge.
 * Returns undefined if no bridge is running for this skill.
 */
export function getBridgePort(skillName: string): number | undefined {
  return bridges.get(skillName)?.port;
}

/**
 * Call a tool on a running MCP bridge's upstream server.
 * Used by the orchestrator to send messages via MCP skills (e.g., send_message).
 */
export async function callBridgeTool(
  skillName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const entry = bridges.get(skillName);
  if (!entry || !entry.healthy) return false;

  try {
    await entry.upstream.callTool({ name: toolName, arguments: args });
    return true;
  } catch (err) {
    logger.error({ skill: skillName, tool: toolName, err }, 'callBridgeTool failed');
    return false;
  }
}

async function startBridge(
  skill: LoadedSkill,
  port: number,
  onInboxEvent?: (event: InboxEvent) => void,
): Promise<void> {
  const mcp = skill.manifest.mcp!;
  const name = skill.manifest.name;

  // Resolve env vars for the MCP server
  let env: Record<string, string> | undefined;
  if (mcp.envKeys && mcp.envKeys.length > 0) {
    env = readEnvFile(mcp.envKeys);
  }

  // 1. Spawn upstream MCP server and connect as client
  const upstreamTransport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args,
    cwd: skill.dir, // resolve relative paths in skill.json from the skill directory
    env: { ...process.env, ...env } as Record<string, string>,
  });

  const upstream = new Client({
    name: `nonnaclaw-bridge-${name}`,
    version: '1.0.0',
  });

  await upstream.connect(upstreamTransport);

  // Cache upstream tool list
  const { tools: upstreamTools } = await upstream.listTools();
  logger.debug(
    { skill: name, toolCount: upstreamTools.length },
    'Upstream MCP tools discovered',
  );

  // 2. Create forwarding MCP server (no filtering — scoping in container proxy)
  const mcpServer = new Server(
    { name: `nonnaclaw-bridge-${name}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: upstreamTools };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    return await upstream.callTool({ name: toolName, arguments: args });
  });

  // 3. Create HTTP transport and server
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await mcpServer.connect(httpTransport);

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for container access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, mcp-session-id',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await httpTransport.handleRequest(req, res);
    } catch (err) {
      logger.error({ skill: name, err }, 'HTTP transport error');
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '0.0.0.0', () => resolve());
    httpServer.on('error', reject);
  });

  const entry: BridgeEntry = {
    skillName: name,
    port,
    upstream,
    upstreamTransport,
    mcpServer,
    httpTransport,
    httpServer,
    healthy: true,
  };

  bridges.set(name, entry);

  // 4. Start inbound polling if configured
  if (mcp.pollTool && onInboxEvent) {
    const interval = mcp.pollIntervalMs ?? MCP_DEFAULT_POLL_INTERVAL;
    // Start from "now" so we don't replay historical messages on restart.
    // Use local ISO format to match what the upstream DB stores (SQLite
    // compares timestamps as strings, so timezone-offset representation
    // must be consistent — UTC "2026-03-01T06:..." sorts after local
    // "2026-02-28 22:..." even when they represent the same instant).
    let lastPollTimestamp: string | undefined = localISOString();

    entry.pollTimer = setInterval(async () => {
      try {
        const args: Record<string, unknown> = {};
        if (lastPollTimestamp) {
          const argName = mcp.pollTimestampArg ?? 'since';
          args[argName] = lastPollTimestamp;
        }

        const result = await upstream.callTool({
          name: mcp.pollTool!,
          arguments: args,
        });

        // Process results as potential inbox events
        if (result.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              try {
                const parsed = JSON.parse(item.text);
                if (Array.isArray(parsed)) {
                  for (const msg of parsed) {
                    processPolledMessage(name, msg, onInboxEvent);
                    if (msg.timestamp) lastPollTimestamp = msg.timestamp;
                  }
                } else if (parsed && typeof parsed === 'object') {
                  processPolledMessage(name, parsed, onInboxEvent);
                  if (parsed.timestamp) lastPollTimestamp = parsed.timestamp;
                }
              } catch {
                // Not JSON, skip
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ skill: name, err }, 'Inbound poll failed');
      }
    }, interval);
  }

  // 5. Health check
  entry.healthTimer = setInterval(async () => {
    try {
      await upstream.listTools();
      entry.healthy = true;
    } catch {
      entry.healthy = false;
      logger.warn({ skill: name }, 'MCP health check failed');
    }
  }, MCP_HEALTH_INTERVAL);
}

function processPolledMessage(
  skillName: string,
  msg: Record<string, unknown>,
  onInboxEvent: (event: InboxEvent) => void,
): void {
  // Map common MCP server response fields to InboxEvent.
  // Supports lharries/whatsapp-mcp (chat_jid, sender_jid, message),
  // jlucaso1/whatsapp-mcp-ts, and generic field names.
  const rawTimestamp = msg.timestamp ?? msg.created_at;
  let timestamp: string;
  if (typeof rawTimestamp === 'number') {
    // Unix seconds → ISO 8601
    timestamp = new Date(rawTimestamp * 1000).toISOString();
  } else {
    timestamp = String(rawTimestamp ?? new Date().toISOString());
  }

  const event: InboxEvent = {
    channel: skillName,
    chatId: String(msg.chat_id ?? msg.chatId ?? msg.chat_jid ?? ''),
    content: String(msg.content ?? msg.text ?? msg.body ?? msg.message ?? ''),
    sender: String(msg.sender ?? msg.from ?? msg.sender_jid ?? ''),
    senderName: String(
      msg.sender_name ?? msg.senderName ?? msg.pushName ?? msg.sender_jid ?? '',
    ),
    timestamp,
    messageId:
      (msg.message_id ?? msg.id) ? String(msg.message_id ?? msg.id) : undefined,
    metadata: {
      isGroup: msg.is_group ?? msg.isGroup,
      isBotMessage: msg.is_from_me ?? msg.isFromMe,
    },
  };

  if (!event.chatId || !event.content) return;

  onInboxEvent(event);
}
