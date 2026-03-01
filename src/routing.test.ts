import { describe, it, expect, beforeEach } from 'vitest';

import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns registered groups', () => {
    _setRegisteredGroups({
      'group1@g.us': {
        name: 'Group 1',
        folder: 'group1',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:01.000Z',
      },
      'group2@g.us': {
        name: 'Group 2',
        folder: 'group2',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:03.000Z',
      },
    });

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
  });

  it('all returned groups are marked as registered', () => {
    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].isRegistered).toBe(true);
    expect(groups[0].name).toBe('Registered');
  });

  it('returns empty array when no groups registered', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });

  it('includes correct JID and name', () => {
    _setRegisteredGroups({
      'test@g.us': {
        name: 'Test Group',
        folder: 'test',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('test@g.us');
    expect(groups[0].name).toBe('Test Group');
  });
});
