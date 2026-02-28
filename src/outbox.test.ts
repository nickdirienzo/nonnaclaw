import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { writeOutboxEvent } from './outbox.js';
import { OutboxEvent } from './types.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const DATA_DIR = '/tmp/nanoclaw-test-outbox';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-outbox',
}));

describe('writeOutboxEvent', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(DATA_DIR)) {
      fs.rmSync(DATA_DIR, { recursive: true });
    }
  });

  it('writes event as JSON to the skill outbox directory', () => {
    const event: OutboxEvent = {
      type: 'message',
      jid: '12345@g.us',
      text: 'Hello world',
      timestamp: new Date().toISOString(),
    };

    writeOutboxEvent('whatsapp', event);

    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', 'whatsapp');
    const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const written = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf-8'));
    expect(written.type).toBe('message');
    expect(written.jid).toBe('12345@g.us');
    expect(written.text).toBe('Hello world');
  });

  it('creates outbox directory if it does not exist', () => {
    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', 'new-skill');
    expect(fs.existsSync(outboxDir)).toBe(false);

    writeOutboxEvent('new-skill', {
      type: 'message',
      jid: 'test@g.us',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(fs.existsSync(outboxDir)).toBe(true);
  });

  it('writes multiple events as separate files', () => {
    for (let i = 0; i < 3; i++) {
      writeOutboxEvent('multi', {
        type: 'message',
        jid: 'test@g.us',
        text: `message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', 'multi');
    const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(3);
  });

  it('does not leave .tmp files after write', () => {
    writeOutboxEvent('clean', {
      type: 'message',
      jid: 'test@g.us',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', 'clean');
    const tmpFiles = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('writes typing events', () => {
    const event: OutboxEvent = {
      type: 'typing',
      jid: '12345@g.us',
      isTyping: true,
      timestamp: new Date().toISOString(),
    };

    writeOutboxEvent('whatsapp', event);

    const outboxDir = path.join(DATA_DIR, 'events', 'outbox', 'whatsapp');
    const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
    const written = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf-8'));
    expect(written.type).toBe('typing');
    expect(written.isTyping).toBe(true);
  });
});
