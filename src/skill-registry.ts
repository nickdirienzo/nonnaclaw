import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { LoadedSkill, SkillManifest } from './types.js';

const DEFAULT_SKILLS_DIR = path.resolve(process.cwd(), 'skills');

/**
 * Scan each skills subdirectory for skill.json and return validated LoadedSkill entries.
 * If the skills directory doesn't exist, returns empty array (no-op).
 */
export function loadSkills(skillsDir?: string): LoadedSkill[] {
  const SKILLS_DIR = skillsDir ?? DEFAULT_SKILLS_DIR;
  if (!fs.existsSync(SKILLS_DIR)) {
    logger.info('No skills/ directory found');
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch (err) {
    logger.warn({ err }, 'Failed to read skills/ directory');
    return [];
  }

  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    const skillDir = path.join(SKILLS_DIR, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const manifestPath = path.join(skillDir, 'skill.json');
    if (!fs.existsSync(manifestPath)) {
      logger.debug({ skillDir }, 'Skipping skill directory without skill.json');
      continue;
    }

    let manifest: SkillManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      logger.warn({ skillDir, err }, 'Failed to parse skill.json, skipping');
      continue;
    }

    if (!manifest.name || !manifest.version) {
      logger.warn(
        { skillDir },
        'skill.json missing required fields (name, version), skipping',
      );
      continue;
    }

    // Validate inbound entrypoint exists on disk
    if (manifest.inbound) {
      const entrypoint = path.resolve(skillDir, manifest.inbound.entrypoint);
      if (!fs.existsSync(entrypoint)) {
        logger.warn(
          { skillDir, entrypoint: manifest.inbound.entrypoint },
          'Inbound entrypoint not found, skipping inbound config',
        );
        manifest.inbound = undefined;
      }
      // For poll mode (non-persistent), require and validate intervalMs
      if (manifest.inbound && !manifest.inbound.persistent) {
        if (!manifest.inbound.intervalMs) {
          logger.warn(
            { skillDir },
            'Inbound intervalMs required for poll mode, skipping inbound config',
          );
          manifest.inbound = undefined;
        } else if (manifest.inbound.intervalMs < 1000) {
          logger.warn(
            { skillDir, intervalMs: manifest.inbound.intervalMs },
            'Inbound intervalMs below minimum (1000ms), clamping',
          );
          manifest.inbound.intervalMs = 1000;
        }
      }
    }

    // Resolve env vars for the inbound entrypoint
    const allEnvKeys = manifest.envKeys || [];
    const inboundEnv = allEnvKeys.length > 0
      ? readEnvFile(allEnvKeys)
      : undefined;

    skills.push({ manifest, dir: skillDir, inboundEnv });
    logger.info(
      {
        name: manifest.name,
        version: manifest.version,
        hasMcp: !!manifest.mcpServers,
        hasInbound: !!manifest.inbound,
      },
      'Skill loaded',
    );
  }

  return skills;
}

/**
 * Filter loaded skills by a group's authorization list and build
 * MCP server configs ready for the Claude SDK's mcpServers parameter.
 */
export function collectMcpServers(
  skills: LoadedSkill[],
  authorizedServerNames: string[],
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const authorized = new Set(authorizedServerNames);
  const result: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};

  for (const skill of skills) {
    if (!skill.manifest.mcpServers) continue;

    for (const [serverName, serverConfig] of Object.entries(
      skill.manifest.mcpServers,
    )) {
      if (!authorized.has(serverName)) continue;

      // Resolve env keys to values from .env
      let env: Record<string, string> | undefined;
      if (serverConfig.envKeys && serverConfig.envKeys.length > 0) {
        env = readEnvFile(serverConfig.envKeys);
      }

      result[serverName] = {
        command: serverConfig.command,
        args: serverConfig.args,
        env,
      };
    }
  }

  return result;
}

/**
 * Match a JID against loaded skills' outbound.jidPatterns.
 * Returns the skill name that handles outbound for this JID, or undefined.
 */
export function resolveSkillForJid(
  skills: LoadedSkill[],
  jid: string,
): string | undefined {
  for (const skill of skills) {
    if (!skill.manifest.outbound?.jidPatterns) continue;
    for (const pattern of skill.manifest.outbound.jidPatterns) {
      if (matchJidPattern(pattern, jid)) {
        return skill.manifest.name;
      }
    }
  }
  return undefined;
}

function matchJidPattern(pattern: string, jid: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) {
    return jid.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return jid.startsWith(pattern.slice(0, -1));
  }
  return jid === pattern;
}
