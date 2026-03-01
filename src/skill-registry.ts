import fs from 'fs';
import path from 'path';

import { SKILLS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getBridgePort, registerGroupScope } from './mcp-bridge.js';
import {
  LoadedSkill,
  RegisteredGroup,
  SkillManifest,
  SkillScope,
} from './types.js';

/**
 * Scan each skills subdirectory for skill.json and return validated LoadedSkill entries.
 * If the skills directory doesn't exist, returns empty array (no-op).
 */
export function loadSkills(skillsDir?: string): LoadedSkill[] {
  const dir = skillsDir ?? SKILLS_DIR;
  if (!fs.existsSync(dir)) {
    logger.info('No nonnaclaw-skills/ directory found');
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    logger.warn({ err }, 'Failed to read nonnaclaw-skills/ directory');
    return [];
  }

  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
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

    skills.push({ manifest, dir: skillDir });
    logger.info(
      {
        name: manifest.name,
        version: manifest.version,
        hasMcp: !!manifest.mcp || !!manifest.mcpServers,
        hasScopeTemplate: !!manifest.scopeTemplate,
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
): Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
> {
  const authorized = new Set(authorizedServerNames);
  const result: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  > = {};

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
 * Find the skill that can send messages to a JID.
 * Returns the first MCP skill with send_message capability.
 */
export function resolveSkillForJid(
  skills: LoadedSkill[],
  _jid: string,
): string | undefined {
  for (const skill of skills) {
    if (
      skill.manifest.mcp &&
      skill.manifest.scopeTemplate?.send_message?.allow
    ) {
      return skill.manifest.name;
    }
  }
  return undefined;
}

/**
 * Build proxied MCP server configs for a group.
 *
 * For skills with a `mcp` field and `scopeTemplate`, registers a host-side
 * filtered scope on the MCP bridge and returns a forwarder config that
 * connects the container to the scoped endpoint.
 *
 * Falls back to legacy `collectMcpServers` for skills using `mcpServers` field.
 *
 * @param mcpForwarderPath - absolute path to the compiled mcp-forwarder.js inside the container
 */
export function collectProxiedMcpServers(
  skills: LoadedSkill[],
  group: RegisteredGroup,
  mcpForwarderPath: string,
): Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
> {
  const result: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  > = {};

  // New-style: skills with `mcp` field, authorized via `authorizedSkills`
  if (group.authorizedSkills) {
    for (const [skillName, scope] of Object.entries(group.authorizedSkills)) {
      const skill = skills.find((s) => s.manifest.name === skillName);
      if (!skill?.manifest.mcp) continue;

      const bridgePort = getBridgePort(skillName);
      if (!bridgePort) {
        logger.error(
          { skill: skillName, group: group.folder },
          'No MCP bridge running for skill — skipping (host-side enforcement required)',
        );
        continue;
      }

      const rules = buildProxyRules(skill.manifest, scope);

      // Register host-side filtered scope (fire-and-forget — bridge is already running)
      registerGroupScope(skillName, group.folder, rules).catch((err) => {
        logger.error(
          { skill: skillName, group: group.folder, err },
          'Failed to register group scope',
        );
      });

      result[skillName] = {
        command: 'node',
        args: [mcpForwarderPath],
        env: {
          MCP_UPSTREAM_URL: `http://host.docker.internal:${bridgePort}/mcp/${group.folder}`,
        },
      };
    }
  }

  // Legacy fallback: skills using `mcpServers` field, authorized via `authorizedMcpServers`
  if (group.authorizedMcpServers && group.authorizedMcpServers.length > 0) {
    const legacy = collectMcpServers(skills, group.authorizedMcpServers);
    for (const [name, config] of Object.entries(legacy)) {
      if (!result[name]) {
        result[name] = config;
      }
    }
  }

  return result;
}

/**
 * Build proxy rules from a skill's scopeTemplate + group's scoping config.
 * The scopeTemplate declares which tools to expose and which params are sensitive.
 * The group's SkillScope provides the actual pinned values.
 */
function buildProxyRules(
  manifest: SkillManifest,
  scope: SkillScope,
): Record<string, { allow: boolean; pinnedParams?: Record<string, string> }> {
  const rules: Record<
    string,
    { allow: boolean; pinnedParams?: Record<string, string> }
  > = {};

  if (!manifest.scopeTemplate) {
    // No scope template — block everything (secure by default)
    return rules;
  }

  for (const [toolName, templateRule] of Object.entries(
    manifest.scopeTemplate,
  )) {
    const rule: { allow: boolean; pinnedParams?: Record<string, string> } = {
      allow: templateRule.allow,
    };

    // Resolve scoped params from the group's pinned values
    if (templateRule.scopedParams && scope.pinnedParams) {
      const pinned: Record<string, string> = {};
      for (const paramName of templateRule.scopedParams) {
        const key = `${toolName}.${paramName}`;
        if (scope.pinnedParams[key]) {
          pinned[paramName] = scope.pinnedParams[key];
        }
      }
      if (Object.keys(pinned).length > 0) {
        rule.pinnedParams = pinned;
      }
    }

    rules[toolName] = rule;
  }

  return rules;
}
