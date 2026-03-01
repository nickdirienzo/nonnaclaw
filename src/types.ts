export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

/** Per-skill scoping config for a group */
export interface SkillScope {
  pinnedParams?: Record<string, string>; // "tool.param" → value
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  /** @deprecated Use authorizedSkills instead */
  authorizedMcpServers?: string[];
  /** Per-skill authorization with scoping config */
  authorizedSkills?: Record<string, SkillScope>;
}

// --- Skill system types ---

/** Scope template rule — skill author declares which tools to expose and which params are security-sensitive */
export interface ScopeTemplateRule {
  allow: boolean;
  scopedParams?: string[]; // param names that must be pinned per-group (e.g., ["chat_id"])
}

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  /** The MCP server this skill provides (proxied to agents with scoping) */
  mcp?: {
    command: string;
    args?: string[];
    envKeys?: string[]; // env var names — values resolved from .env at runtime
    /** MCP tool to poll for inbound messages (e.g., "list_messages") */
    pollTool?: string;
    /** Poll interval in ms (default: 5000) */
    pollIntervalMs?: number;
    /** Argument name for the "since" timestamp when polling (default: "since") */
    pollTimestampArg?: string;
  };
  /** Declares which tools to expose and which params need per-group pinning */
  scopeTemplate?: Record<string, ScopeTemplateRule>;
  /** @deprecated Use mcp + scopeTemplate. Kept for backward compat with handler-based skills. */
  inbound?: {
    entrypoint: string; // relative path, e.g. "./inbound.js"
    intervalMs?: number; // poll interval, min 1000ms (required for poll mode)
    persistent?: boolean; // if true, process runs continuously (restart on crash)
  };
  /** @deprecated Use mcp + scopeTemplate. */
  outbound?: {
    jidPatterns: string[]; // glob patterns for JIDs this skill handles, e.g. ["*@g.us"]
  };
  /** @deprecated Use mcp field instead. Agent-facing MCP servers (legacy). */
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      envKeys?: string[]; // env var names — values resolved from .env at runtime
    }
  >;
  envKeys?: string[]; // env vars for the inbound entrypoint
}

export interface InboxEvent {
  channel: string;
  chatId: string;
  type?: 'message' | 'chat_metadata'; // defaults to 'message'
  content: string;
  sender: string;
  senderName: string;
  timestamp: string; // ISO 8601
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboxEvent {
  type: 'message' | 'typing';
  jid: string;
  text?: string;
  isTyping?: boolean;
  sender?: string;
  timestamp: string;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  dir: string; // absolute path to skill directory
  inboundEnv?: Record<string, string>;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

