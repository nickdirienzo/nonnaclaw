import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  loadSkills,
  collectMcpServers,
  resolveSkillForJid,
} from './skill-registry.js';
import { LoadedSkill } from './types.js';

// Mock dependencies
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const vals: Record<string, string> = {
      GITHUB_TOKEN: 'ghp_test123',
      SLACK_TOKEN: 'xoxb-test',
    };
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (vals[key]) result[key] = vals[key];
    }
    return result;
  }),
}));

const SKILLS_DIR = '/tmp/nanoclaw-test-skills';

describe('loadSkills', () => {
  beforeEach(() => {
    if (fs.existsSync(SKILLS_DIR)) {
      fs.rmSync(SKILLS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(SKILLS_DIR)) {
      fs.rmSync(SKILLS_DIR, { recursive: true });
    }
  });

  it('returns empty array when skills/ directory does not exist', () => {
    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toEqual([]);
  });

  it('returns empty array when skills/ directory is empty', () => {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toEqual([]);
  });

  it('skips directories without skill.json', () => {
    const skillDir = path.join(SKILLS_DIR, 'no-manifest');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'README.md'), 'hello');

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toEqual([]);
  });

  it('skips manifests with missing required fields', () => {
    const skillDir = path.join(SKILLS_DIR, 'bad-manifest');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({ description: 'missing name and version' }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toEqual([]);
  });

  it('skips invalid JSON in skill.json', () => {
    const skillDir = path.join(SKILLS_DIR, 'bad-json');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), '{invalid json');

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toEqual([]);
  });

  it('loads a valid skill with MCP servers', () => {
    const skillDir = path.join(SKILLS_DIR, 'github');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'github',
        version: '1.0.0',
        mcpServers: {
          github_api: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            envKeys: ['GITHUB_TOKEN'],
          },
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.name).toBe('github');
    expect(skills[0].manifest.mcpServers).toBeDefined();
    expect(skills[0].dir).toBe(skillDir);
  });

  it('loads a skill with inbound config when entrypoint exists', () => {
    const skillDir = path.join(SKILLS_DIR, 'telegram');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'inbound.js'), 'console.log("ok")');
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'telegram',
        version: '1.0.0',
        inbound: {
          entrypoint: './inbound.js',
          intervalMs: 5000,
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.inbound).toBeDefined();
    expect(skills[0].manifest.inbound!.intervalMs).toBe(5000);
  });

  it('strips inbound config when entrypoint does not exist', () => {
    const skillDir = path.join(SKILLS_DIR, 'missing-entry');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'missing-entry',
        version: '1.0.0',
        inbound: {
          entrypoint: './does-not-exist.js',
          intervalMs: 5000,
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.inbound).toBeUndefined();
  });

  it('clamps intervalMs below 1000ms', () => {
    const skillDir = path.join(SKILLS_DIR, 'fast');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'poll.js'), '');
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'fast',
        version: '1.0.0',
        inbound: {
          entrypoint: './poll.js',
          intervalMs: 100,
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills[0].manifest.inbound!.intervalMs).toBe(1000);
  });

  it('loads persistent skill without intervalMs', () => {
    const skillDir = path.join(SKILLS_DIR, 'whatsapp');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'service.js'), '');
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'whatsapp',
        version: '1.0.0',
        inbound: {
          entrypoint: './service.js',
          persistent: true,
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.inbound).toBeDefined();
    expect(skills[0].manifest.inbound!.persistent).toBe(true);
    expect(skills[0].manifest.inbound!.intervalMs).toBeUndefined();
  });

  it('strips poll-mode inbound without intervalMs', () => {
    const skillDir = path.join(SKILLS_DIR, 'bad-poll');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'poll.js'), '');
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'bad-poll',
        version: '1.0.0',
        inbound: {
          entrypoint: './poll.js',
          // no intervalMs and not persistent — should be stripped
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.inbound).toBeUndefined();
  });

  it('loads skill with outbound jidPatterns', () => {
    const skillDir = path.join(SKILLS_DIR, 'wa');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      JSON.stringify({
        name: 'wa',
        version: '1.0.0',
        outbound: {
          jidPatterns: ['*@g.us', '*@s.whatsapp.net'],
        },
      }),
    );

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.outbound).toBeDefined();
    expect(skills[0].manifest.outbound!.jidPatterns).toEqual([
      '*@g.us',
      '*@s.whatsapp.net',
    ]);
  });

  it('loads multiple skills', () => {
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(SKILLS_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'skill.json'),
        JSON.stringify({ name, version: '1.0.0' }),
      );
    }

    const skills = loadSkills(SKILLS_DIR);
    expect(skills).toHaveLength(2);
  });
});

describe('collectMcpServers', () => {
  const skills: LoadedSkill[] = [
    {
      manifest: {
        name: 'github',
        version: '1.0.0',
        mcpServers: {
          github_api: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            envKeys: ['GITHUB_TOKEN'],
          },
        },
      },
      dir: '/skills/github',
    },
    {
      manifest: {
        name: 'slack',
        version: '1.0.0',
        mcpServers: {
          slack_api: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-slack'],
            envKeys: ['SLACK_TOKEN'],
          },
        },
      },
      dir: '/skills/slack',
    },
    {
      manifest: {
        name: 'no-mcp',
        version: '1.0.0',
      },
      dir: '/skills/no-mcp',
    },
  ];

  it('returns only authorized servers', () => {
    const result = collectMcpServers(skills, ['github_api']);
    expect(Object.keys(result)).toEqual(['github_api']);
    expect(result.github_api.command).toBe('npx');
  });

  it('returns multiple authorized servers', () => {
    const result = collectMcpServers(skills, ['github_api', 'slack_api']);
    expect(Object.keys(result).sort()).toEqual(['github_api', 'slack_api']);
  });

  it('returns empty for no matching authorization', () => {
    const result = collectMcpServers(skills, ['nonexistent']);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns empty for empty authorization list', () => {
    const result = collectMcpServers(skills, []);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('skips skills without mcpServers', () => {
    const result = collectMcpServers(skills, ['github_api']);
    // Should not throw, just skip the no-mcp skill
    expect(Object.keys(result)).toEqual(['github_api']);
  });
});

describe('resolveSkillForJid', () => {
  const skills: LoadedSkill[] = [
    {
      manifest: {
        name: 'whatsapp',
        version: '1.0.0',
        outbound: {
          jidPatterns: ['*@g.us', '*@s.whatsapp.net', '*@lid'],
        },
      },
      dir: '/skills/whatsapp',
    },
    {
      manifest: {
        name: 'telegram',
        version: '1.0.0',
        outbound: {
          jidPatterns: ['tg:*'],
        },
      },
      dir: '/skills/telegram',
    },
    {
      manifest: {
        name: 'no-outbound',
        version: '1.0.0',
      },
      dir: '/skills/no-outbound',
    },
  ];

  it('matches suffix pattern *@g.us', () => {
    expect(resolveSkillForJid(skills, '12345@g.us')).toBe('whatsapp');
  });

  it('matches suffix pattern *@s.whatsapp.net', () => {
    expect(resolveSkillForJid(skills, '5551234@s.whatsapp.net')).toBe(
      'whatsapp',
    );
  });

  it('matches suffix pattern *@lid', () => {
    expect(resolveSkillForJid(skills, 'abc123@lid')).toBe('whatsapp');
  });

  it('matches prefix pattern tg:*', () => {
    expect(resolveSkillForJid(skills, 'tg:chat456')).toBe('telegram');
  });

  it('returns undefined for unmatched JID', () => {
    expect(resolveSkillForJid(skills, 'slack:channel1')).toBeUndefined();
  });

  it('skips skills without outbound config', () => {
    expect(resolveSkillForJid(skills, 'anything')).toBeUndefined();
  });

  it('returns first matching skill when multiple could match', () => {
    const overlapping: LoadedSkill[] = [
      {
        manifest: {
          name: 'first',
          version: '1.0.0',
          outbound: { jidPatterns: ['*'] },
        },
        dir: '/skills/first',
      },
      {
        manifest: {
          name: 'second',
          version: '1.0.0',
          outbound: { jidPatterns: ['*'] },
        },
        dir: '/skills/second',
      },
    ];
    expect(resolveSkillForJid(overlapping, 'any@jid')).toBe('first');
  });

  it('matches exact JID pattern', () => {
    const exact: LoadedSkill[] = [
      {
        manifest: {
          name: 'specific',
          version: '1.0.0',
          outbound: { jidPatterns: ['admin@g.us'] },
        },
        dir: '/skills/specific',
      },
    ];
    expect(resolveSkillForJid(exact, 'admin@g.us')).toBe('specific');
    expect(resolveSkillForJid(exact, 'other@g.us')).toBeUndefined();
  });

  it('matches wildcard * pattern (matches everything)', () => {
    const catchAll: LoadedSkill[] = [
      {
        manifest: {
          name: 'catch-all',
          version: '1.0.0',
          outbound: { jidPatterns: ['*'] },
        },
        dir: '/skills/catch-all',
      },
    ];
    expect(resolveSkillForJid(catchAll, 'anything@anywhere')).toBe('catch-all');
  });

  it('returns undefined for empty skills array', () => {
    expect(resolveSkillForJid([], '12345@g.us')).toBeUndefined();
  });
});
