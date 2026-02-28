import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  startInboundSchedulers,
  stopInboundSchedulers,
} from './skill-inbound.js';
import { InboxEvent, LoadedSkill } from './types.js';

// Mock dependencies
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-inbound',
  STORE_DIR: '/tmp/nanoclaw-test-inbound/store',
}));

const DATA_DIR = '/tmp/nanoclaw-test-inbound';
const INBOX_DIR = path.join(DATA_DIR, 'events', 'inbox');
const ERRORS_DIR = path.join(DATA_DIR, 'events', 'errors');

describe('inbox event routing', () => {
  beforeEach(() => {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.mkdirSync(ERRORS_DIR, { recursive: true });
  });

  afterEach(() => {
    stopInboundSchedulers();
    if (fs.existsSync(DATA_DIR)) {
      fs.rmSync(DATA_DIR, { recursive: true });
    }
  });

  it('routes valid inbox event to correct group', async () => {
    const stored: Array<{ chat_jid: string; content: string }> = [];

    const deps = {
      resolveGroup: (channel: string, chatId: string) => {
        if (channel === 'telegram' && chatId === 'chat123')
          return 'tg:chat123';
        return undefined;
      },
      storeAndNotify: (msg: {
        id: string;
        chat_jid: string;
        sender: string;
        sender_name: string;
        content: string;
        timestamp: string;
        is_from_me: boolean;
      }) => {
        stored.push({ chat_jid: msg.chat_jid, content: msg.content });
      },
    };

    // Write an inbox event
    const event: InboxEvent = {
      channel: 'telegram',
      chatId: 'chat123',
      content: 'Hello from Telegram',
      sender: 'user1',
      senderName: 'Alice',
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, '001.json'),
      JSON.stringify(event),
    );

    // Start with no skills (just the inbox poller)
    startInboundSchedulers([], deps);

    // Wait for poller to run
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(stored).toHaveLength(1);
    expect(stored[0].chat_jid).toBe('tg:chat123');
    expect(stored[0].content).toBe('Hello from Telegram');

    // File should be consumed
    expect(fs.existsSync(path.join(INBOX_DIR, '001.json'))).toBe(false);
  });

  it('moves malformed events to errors directory', async () => {
    const deps = {
      resolveGroup: () => undefined,
      storeAndNotify: vi.fn(),
    };

    // Write a malformed event (missing required fields)
    fs.writeFileSync(
      path.join(INBOX_DIR, 'bad.json'),
      JSON.stringify({ channel: 'test' }),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(deps.storeAndNotify).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ERRORS_DIR, 'bad.json'))).toBe(true);
  });

  it('skips events with no group mapping', async () => {
    const deps = {
      resolveGroup: () => undefined,
      storeAndNotify: vi.fn(),
    };

    const event: InboxEvent = {
      channel: 'unknown',
      chatId: 'no-mapping',
      content: 'Hello',
      sender: 'user1',
      senderName: 'Alice',
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, 'skip.json'),
      JSON.stringify(event),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(deps.storeAndNotify).not.toHaveBeenCalled();
    // File should be consumed (deleted, not errored)
    expect(fs.existsSync(path.join(INBOX_DIR, 'skip.json'))).toBe(false);
  });

  it('uses messageId for dedup when provided', async () => {
    const stored: Array<{ id: string }> = [];

    const deps = {
      resolveGroup: () => 'group@g.us',
      storeAndNotify: (msg: {
        id: string;
        chat_jid: string;
        sender: string;
        sender_name: string;
        content: string;
        timestamp: string;
        is_from_me: boolean;
      }) => {
        stored.push({ id: msg.id });
      },
    };

    const event: InboxEvent = {
      channel: 'test',
      chatId: 'chat1',
      content: 'Hello',
      sender: 'user1',
      senderName: 'Alice',
      timestamp: new Date().toISOString(),
      messageId: 'custom-msg-id',
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, 'dedup.json'),
      JSON.stringify(event),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('custom-msg-id');
  });

  it('routes chat_metadata events to storeChatMetadata callback', async () => {
    const metadataEvents: Array<{
      chatJid: string;
      name?: string;
      channel?: string;
      isGroup?: boolean;
    }> = [];

    const deps = {
      resolveGroup: () => undefined,
      storeAndNotify: vi.fn(),
      storeChatMetadata: (
        chatJid: string,
        _timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        metadataEvents.push({ chatJid, name, channel, isGroup });
      },
    };

    const event: InboxEvent = {
      channel: 'whatsapp',
      chatId: '12345@g.us',
      type: 'chat_metadata',
      content: '',
      sender: '',
      senderName: '',
      timestamp: new Date().toISOString(),
      metadata: { name: 'Family Chat', isGroup: true },
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, 'meta.json'),
      JSON.stringify(event),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(deps.storeAndNotify).not.toHaveBeenCalled();
    expect(metadataEvents).toHaveLength(1);
    expect(metadataEvents[0].chatJid).toBe('12345@g.us');
    expect(metadataEvents[0].name).toBe('Family Chat');
    expect(metadataEvents[0].channel).toBe('whatsapp');
    expect(metadataEvents[0].isGroup).toBe(true);
    // File should be consumed
    expect(fs.existsSync(path.join(INBOX_DIR, 'meta.json'))).toBe(false);
  });

  it('silently consumes chat_metadata when no storeChatMetadata callback', async () => {
    const deps = {
      resolveGroup: () => undefined,
      storeAndNotify: vi.fn(),
      // no storeChatMetadata
    };

    const event: InboxEvent = {
      channel: 'whatsapp',
      chatId: '12345@g.us',
      type: 'chat_metadata',
      content: '',
      sender: '',
      senderName: '',
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, 'meta-no-cb.json'),
      JSON.stringify(event),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(deps.storeAndNotify).not.toHaveBeenCalled();
    // File should still be consumed (not moved to errors)
    expect(fs.existsSync(path.join(INBOX_DIR, 'meta-no-cb.json'))).toBe(false);
    expect(fs.existsSync(path.join(ERRORS_DIR, 'meta-no-cb.json'))).toBe(false);
  });

  it('passes is_bot_message flag from event metadata', async () => {
    const stored: Array<{ is_bot_message?: boolean }> = [];

    const deps = {
      resolveGroup: () => 'group@g.us',
      storeAndNotify: (msg: {
        id: string;
        chat_jid: string;
        sender: string;
        sender_name: string;
        content: string;
        timestamp: string;
        is_from_me: boolean;
        is_bot_message?: boolean;
      }) => {
        stored.push({ is_bot_message: msg.is_bot_message });
      },
    };

    const event: InboxEvent = {
      channel: 'test',
      chatId: 'chat1',
      content: 'Bot message',
      sender: 'bot',
      senderName: 'Bot',
      timestamp: new Date().toISOString(),
      metadata: { isBotMessage: true },
    };
    fs.writeFileSync(
      path.join(INBOX_DIR, 'bot.json'),
      JSON.stringify(event),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(stored).toHaveLength(1);
    expect(stored[0].is_bot_message).toBe(true);
  });

  it('moves message events without content to errors', async () => {
    const deps = {
      resolveGroup: () => 'group@g.us',
      storeAndNotify: vi.fn(),
    };

    // Has channel and chatId but no content — valid structure but missing content for message type
    fs.writeFileSync(
      path.join(INBOX_DIR, 'no-content.json'),
      JSON.stringify({
        channel: 'test',
        chatId: 'chat1',
        sender: 'user1',
        senderName: 'Alice',
        timestamp: new Date().toISOString(),
      }),
    );

    startInboundSchedulers([], deps);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(deps.storeAndNotify).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ERRORS_DIR, 'no-content.json'))).toBe(true);
  });
});

describe('db channel_mappings', () => {
  // Test the db functions directly since they're tightly coupled

  it('imports without error', async () => {
    // Just verify the module loads
    const mod = await import('./skill-inbound.js');
    expect(mod.startInboundSchedulers).toBeDefined();
    expect(mod.stopInboundSchedulers).toBeDefined();
  });
});
