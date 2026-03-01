import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  loadSkills,
  collectMcpServers,
  collectProxiedMcpServers,
  resolveSkillForJid,
} from './skill-registry.js';
import { LoadedSkill, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

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

const mockRegisterGroupScope = vi.fn<
  (skill: string, group: string, rules: unknown) => Promise<void>
>(async () => {});
const mockGetBridgePort = vi.fn<(name: string) => number | undefined>();

vi.mock('./mcp-bridge.js', () => ({
  getBridgePort: (name: string) => mockGetBridgePort(name),
  registerGroupScope: (skill: string, group: string, rules: unknown) =>
    mockRegisterGroupScope(skill, group, rules),
}));

const SKILLS_DIR = '/tmp/nonnaclaw-test-skills';

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
        mcp: { command: 'uv', args: ['run', 'main.py'] },
        scopeTemplate: {
          send_message: { allow: true, scopedParams: ['recipient'] },
        },
      },
      dir: '/skills/whatsapp',
    },
    {
      manifest: {
        name: 'no-send',
        version: '1.0.0',
        mcp: { command: 'node', args: ['server.js'] },
        scopeTemplate: {
          list_items: { allow: true },
        },
      },
      dir: '/skills/no-send',
    },
    {
      manifest: {
        name: 'no-mcp',
        version: '1.0.0',
      },
      dir: '/skills/no-mcp',
    },
  ];

  it('returns MCP skill with send_message capability', () => {
    expect(resolveSkillForJid(skills, '12345@g.us')).toBe('whatsapp');
  });

  it('skips skills without send_message in scopeTemplate', () => {
    const noSend: LoadedSkill[] = [skills[1], skills[2]];
    expect(resolveSkillForJid(noSend, 'any@jid')).toBeUndefined();
  });

  it('skips skills without mcp config', () => {
    const noMcp: LoadedSkill[] = [skills[2]];
    expect(resolveSkillForJid(noMcp, 'any@jid')).toBeUndefined();
  });

  it('returns first matching skill when multiple have send_message', () => {
    const multi: LoadedSkill[] = [
      {
        manifest: {
          name: 'first',
          version: '1.0.0',
          mcp: { command: 'a' },
          scopeTemplate: { send_message: { allow: true } },
        },
        dir: '/skills/first',
      },
      {
        manifest: {
          name: 'second',
          version: '1.0.0',
          mcp: { command: 'b' },
          scopeTemplate: { send_message: { allow: true } },
        },
        dir: '/skills/second',
      },
    ];
    expect(resolveSkillForJid(multi, 'any@jid')).toBe('first');
  });

  it('returns undefined for empty skills array', () => {
    expect(resolveSkillForJid([], '12345@g.us')).toBeUndefined();
  });
});

describe('collectProxiedMcpServers', () => {
  const FORWARDER_PATH = '/tmp/dist/mcp-forwarder.js';

  const skills: LoadedSkill[] = [
    {
      manifest: {
        name: 'whatsapp',
        version: '1.0.0',
        mcp: { command: 'uv', args: ['run', 'main.py'] },
        scopeTemplate: {
          send_message: { allow: true, scopedParams: ['chat_id'] },
          list_messages: { allow: true },
        },
      },
      dir: '/skills/whatsapp',
    },
    {
      manifest: {
        name: 'no-mcp',
        version: '1.0.0',
      },
      dir: '/skills/no-mcp',
    },
  ];

  const group: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2026-01-01',
    authorizedSkills: {
      whatsapp: {
        pinnedParams: {
          'send_message.chat_id': '12345@g.us',
        },
      },
    },
  };

  beforeEach(() => {
    mockRegisterGroupScope.mockClear();
    mockGetBridgePort.mockReset();
    vi.mocked(logger.error).mockClear();
  });

  it('with bridge: calls registerGroupScope and returns forwarder config', () => {
    mockGetBridgePort.mockReturnValue(19700);

    const result = collectProxiedMcpServers(skills, group, FORWARDER_PATH);

    expect(mockRegisterGroupScope).toHaveBeenCalledWith(
      'whatsapp',
      'test-group',
      expect.objectContaining({
        send_message: {
          allow: true,
          pinnedParams: { chat_id: '12345@g.us' },
        },
        list_messages: { allow: true },
      }),
    );

    expect(result.whatsapp).toBeDefined();
    expect(result.whatsapp.command).toBe('node');
    expect(result.whatsapp.args).toEqual([FORWARDER_PATH]);
    expect(result.whatsapp.env).toEqual({
      MCP_UPSTREAM_URL:
        'http://host.docker.internal:19700/mcp/test-group',
    });
  });

  it('without bridge: skips skill and logs error', () => {
    mockGetBridgePort.mockReturnValue(undefined);

    const result = collectProxiedMcpServers(skills, group, FORWARDER_PATH);

    expect(Object.keys(result)).toHaveLength(0);
    expect(mockRegisterGroupScope).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'whatsapp', group: 'test-group' }),
      expect.stringContaining('No MCP bridge running'),
    );
  });

  it('skips skills without mcp config even if authorized', () => {
    mockGetBridgePort.mockReturnValue(19700);

    const groupWithNoMcp: RegisteredGroup = {
      ...group,
      authorizedSkills: {
        'no-mcp': {},
      },
    };

    const result = collectProxiedMcpServers(
      skills,
      groupWithNoMcp,
      FORWARDER_PATH,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});
