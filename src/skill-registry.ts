import fs from 'fs';
import path from 'path';

import { SKILLS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getBridgePort } from './mcp-bridge.js';
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
    const inboundEnv =
      allEnvKeys.length > 0 ? readEnvFile(allEnvKeys) : undefined;

    skills.push({ manifest, dir: skillDir, inboundEnv });
    logger.info(
      {
        name: manifest.name,
        version: manifest.version,
        hasMcp: !!manifest.mcp || !!manifest.mcpServers,
        hasInbound: !!manifest.inbound,
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
 * Match a JID against loaded skills' outbound.jidPatterns or MCP send capability.
 * Returns the skill name that handles outbound for this JID, or undefined.
 *
 * Priority:
 * 1. Skills with explicit outbound.jidPatterns (pattern match)
 * 2. MCP skills with send_message in scopeTemplate (catch-all for MCP channels)
 */
export function resolveSkillForJid(
  skills: LoadedSkill[],
  jid: string,
): string | undefined {
  // First: check explicit outbound patterns
  for (const skill of skills) {
    if (!skill.manifest.outbound?.jidPatterns) continue;
    for (const pattern of skill.manifest.outbound.jidPatterns) {
      if (matchJidPattern(pattern, jid)) {
        return skill.manifest.name;
      }
    }
  }
  // Fallback: MCP skills with send_message capability
  for (const skill of skills) {
    if (skill.manifest.mcp && skill.manifest.scopeTemplate?.send_message?.allow) {
      return skill.manifest.name;
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

/**
 * Build proxied MCP server configs for a group.
 *
 * For skills with a `mcp` field and `scopeTemplate`, wraps the MCP server
 * with the proxy, applying per-group scoping rules from `authorizedSkills`.
 *
 * Falls back to legacy `collectMcpServers` for skills using `mcpServers` field.
 *
 * @param mcpProxyPath - absolute path to the compiled mcp-proxy.js inside the container
 */
export function collectProxiedMcpServers(
  skills: LoadedSkill[],
  group: RegisteredGroup,
  mcpProxyPath: string,
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

      const rules = buildProxyRules(skill.manifest, scope);

      // If a host-side MCP bridge is running for this skill, connect via HTTP.
      // Otherwise, fall back to spawning the upstream MCP server in the container.
      const bridgePort = getBridgePort(skillName);
      let proxyConfig;

      if (bridgePort) {
        proxyConfig = {
          upstream: {
            url: `http://host.docker.internal:${bridgePort}/mcp`,
          },
          rules,
        };
      } else {
        // Resolve env vars for the upstream MCP server
        let upstreamEnv: Record<string, string> | undefined;
        if (
          skill.manifest.mcp.envKeys &&
          skill.manifest.mcp.envKeys.length > 0
        ) {
          upstreamEnv = readEnvFile(skill.manifest.mcp.envKeys);
        }

        proxyConfig = {
          upstream: {
            command: skill.manifest.mcp.command,
            args: skill.manifest.mcp.args,
            env: upstreamEnv,
          },
          rules,
        };
      }

      result[skillName] = {
        command: 'node',
        args: [mcpProxyPath],
        env: {
          MCP_PROXY_CONFIG: JSON.stringify(proxyConfig),
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
