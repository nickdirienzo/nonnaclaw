import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  deleteChannelMapping,
  getAllChannelMappings,
  getAllRegisteredGroups,
  getChannelMapping,
  getTaskById,
  setChannelMapping,
  setRegisteredGroup,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- Channel mappings ---

describe('channel_mappings', () => {
  it('sets and gets a channel mapping', () => {
    setChannelMapping('telegram', 'chat123', 'tg:chat123');
    const jid = getChannelMapping('telegram', 'chat123');
    expect(jid).toBe('tg:chat123');
  });

  it('returns undefined for missing mapping', () => {
    const jid = getChannelMapping('telegram', 'nonexistent');
    expect(jid).toBeUndefined();
  });

  it('upserts on duplicate (channel, chatId)', () => {
    setChannelMapping('telegram', 'chat1', 'old-jid');
    setChannelMapping('telegram', 'chat1', 'new-jid');
    expect(getChannelMapping('telegram', 'chat1')).toBe('new-jid');
  });

  it('deletes a mapping', () => {
    setChannelMapping('telegram', 'chat1', 'tg:chat1');
    deleteChannelMapping('telegram', 'chat1');
    expect(getChannelMapping('telegram', 'chat1')).toBeUndefined();
  });

  it('lists all mappings', () => {
    setChannelMapping('telegram', 'a', 'tg:a');
    setChannelMapping('slack', 'b', 'sl:b');
    const all = getAllChannelMappings();
    expect(all).toHaveLength(2);
  });
});

// --- authorizedMcpServers on registered groups ---

describe('registered groups authorizedMcpServers', () => {
  it('stores and retrieves authorizedMcpServers', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      authorizedMcpServers: ['github_api', 'slack_api'],
    });

    const groups = getAllRegisteredGroups();
    expect(groups['group@g.us'].authorizedMcpServers).toEqual([
      'github_api',
      'slack_api',
    ]);
  });

  it('stores null when no authorizedMcpServers', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    });

    const groups = getAllRegisteredGroups();
    expect(groups['group@g.us'].authorizedMcpServers).toBeUndefined();
  });
});
