import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createFilteredScope, type ToolRule } from './mcp-bridge.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

/**
 * Helper: invoke a request handler on a scope's mcpServer.
 * The MCP Server stores handlers internally — we access them
 * through the public setRequestHandler/removeRequestHandler API
 * by wrapping the scope in a test harness.
 */
async function callListTools(
  scope: ReturnType<typeof createFilteredScope>,
): Promise<{ tools: Tool[] }> {
  // Access the internal request handler by re-registering and capturing
  // We need to call the handler directly. The Server stores handlers
  // and we can trigger them through the transport.

  // Instead, we'll create a minimal test by sending through transport.
  // But since we're testing the filtering logic, let's extract it differently.

  // The simplest approach: use the server's internal _requestHandlers map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = scope.mcpServer as any;
  const handler = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  if (!handler) throw new Error('No ListTools handler registered');
  return handler({ method: 'tools/list', params: {} });
}

async function callCallTool(
  scope: ReturnType<typeof createFilteredScope>,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = scope.mcpServer as any;
  const handler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  if (!handler) throw new Error('No CallTool handler registered');
  return handler({ method: 'tools/call', params: { name, arguments: args } });
}

// Fake upstream tools
const upstreamTools: Tool[] = [
  {
    name: 'send_message',
    description: 'Send a message',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'list_messages',
    description: 'List messages',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        since: { type: 'string' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
];

function createMockUpstream(): Client {
  return {
    callTool: vi.fn(async ({ name, arguments: args }) => ({
      content: [{ type: 'text', text: `called ${name} with ${JSON.stringify(args)}` }],
    })),
  } as unknown as Client;
}

describe('createFilteredScope', () => {
  let mockUpstream: Client;

  beforeEach(() => {
    mockUpstream = createMockUpstream();
  });

  describe('ListTools filtering', () => {
    it('returns only allowed tools', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: true },
        list_messages: { allow: true },
        delete_message: { allow: false },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callListTools(scope);

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.name).sort()).toEqual([
        'list_messages',
        'send_message',
      ]);
    });

    it('blocks tools not in rules (secure by default)', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: true },
        // list_messages and delete_message not in rules → blocked
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callListTools(scope);

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('send_message');
    });

    it('returns empty tools when all are blocked', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: false },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callListTools(scope);

      expect(result.tools).toHaveLength(0);
    });
  });

  describe('pinned params hidden from schemas', () => {
    it('removes pinned params from tool inputSchema', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: {
          allow: true,
          pinnedParams: { chat_id: '12345@g.us' },
        },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callListTools(scope);

      const tool = result.tools[0];
      expect(tool.name).toBe('send_message');

      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };

      // chat_id should not be in properties
      expect(schema.properties).toBeDefined();
      expect(schema.properties!.chat_id).toBeUndefined();
      expect(schema.properties!.message).toBeDefined();

      // chat_id should not be in required
      expect(schema.required).not.toContain('chat_id');
      expect(schema.required).toContain('message');
    });

    it('leaves schema unchanged when no pinned params', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: true },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callListTools(scope);

      const tool = result.tools[0];
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties!.chat_id).toBeDefined();
      expect(schema.properties!.message).toBeDefined();
    });
  });

  describe('CallTool enforcement', () => {
    it('rejects disallowed tools', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: true },
        delete_message: { allow: false },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callCallTool(scope, 'delete_message', {
        message_id: 'msg1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not allowed');
      expect(mockUpstream.callTool).not.toHaveBeenCalled();
    });

    it('rejects tools not in rules at all', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: { allow: true },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      const result = await callCallTool(scope, 'delete_message', {
        message_id: 'msg1',
      });

      expect(result.isError).toBe(true);
      expect(mockUpstream.callTool).not.toHaveBeenCalled();
    });

    it('injects pinned params overriding agent values', async () => {
      const rules: Record<string, ToolRule> = {
        send_message: {
          allow: true,
          pinnedParams: { chat_id: 'pinned-chat-id' },
        },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      await callCallTool(scope, 'send_message', {
        chat_id: 'agent-tried-to-override',
        message: 'hello',
      });

      expect(mockUpstream.callTool).toHaveBeenCalledWith({
        name: 'send_message',
        arguments: {
          chat_id: 'pinned-chat-id', // pinned wins
          message: 'hello',
        },
      });
    });

    it('forwards allowed tools without pinned params as-is', async () => {
      const rules: Record<string, ToolRule> = {
        list_messages: { allow: true },
      };

      const scope = createFilteredScope(upstreamTools, mockUpstream, rules);
      await callCallTool(scope, 'list_messages', {
        chat_id: 'some-chat',
        since: '2026-01-01',
      });

      expect(mockUpstream.callTool).toHaveBeenCalledWith({
        name: 'list_messages',
        arguments: {
          chat_id: 'some-chat',
          since: '2026-01-01',
        },
      });
    });
  });

  describe('multiple groups get different filtered views', () => {
    it('creates independent scopes with different rules', async () => {
      const rulesGroupA: Record<string, ToolRule> = {
        send_message: {
          allow: true,
          pinnedParams: { chat_id: 'group-a-chat' },
        },
        list_messages: { allow: true },
      };

      const rulesGroupB: Record<string, ToolRule> = {
        send_message: {
          allow: true,
          pinnedParams: { chat_id: 'group-b-chat' },
        },
        // list_messages not allowed for group B
      };

      const scopeA = createFilteredScope(
        upstreamTools,
        mockUpstream,
        rulesGroupA,
      );
      const scopeB = createFilteredScope(
        upstreamTools,
        mockUpstream,
        rulesGroupB,
      );

      const toolsA = await callListTools(scopeA);
      const toolsB = await callListTools(scopeB);

      expect(toolsA.tools).toHaveLength(2);
      expect(toolsB.tools).toHaveLength(1);

      // Group A's send_message should have chat_id pinned to group-a-chat
      await callCallTool(scopeA, 'send_message', { message: 'hi from A' });
      expect(mockUpstream.callTool).toHaveBeenCalledWith({
        name: 'send_message',
        arguments: { chat_id: 'group-a-chat', message: 'hi from A' },
      });

      // Group B's send_message should have chat_id pinned to group-b-chat
      await callCallTool(scopeB, 'send_message', { message: 'hi from B' });
      expect(mockUpstream.callTool).toHaveBeenCalledWith({
        name: 'send_message',
        arguments: { chat_id: 'group-b-chat', message: 'hi from B' },
      });
    });
  });
});
