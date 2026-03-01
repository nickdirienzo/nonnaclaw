# NonnaClaw

An experimental fork of [NanoClaw](https://github.com/qwibitai/NanoClaw) exploring a skill model that adds capabilities without codemods. Uses MCP servers, filesystem IPC, and scoped authorization instead of code generation.

## Philosophy

NanoClaw's "features as skills" model is clever. Instead of bloating the codebase, contributors ship Claude Code skills that rewrite your fork. Want Telegram? Run `/add-telegram` and Claude merges a channel implementation into `src/index.ts`, `src/router.ts`, etc. The code is yours.

The problem is that skills aren't actually isolated. They modify core code paths, the shared SQLite database, and event loops. Each skill is a codemod, and codemods against a moving target create patch management headaches across personal forks. Two skills that touch the same file can conflict. Upstream updates can break your customizations.

This isn't a new problem. Browser extensions, VSCode extensions, Terraform providers. The pattern is well-established: **plugins declare capabilities, the host provides the runtime**. The plugin never patches the host.

Nonnaclaw explores that model for agentic assistants. The core becomes primarily an event router, a container orchestrator, and an interface for inbox/outbox operations. Skills are declarative manifests that point at community MCP servers. Adding WhatsApp means cloning [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) and writing a `skill.json`, not generating code.

For the full motivation, see [Exploring External Skills in NanoClaw](https://nickdirienzo.com/exploring-external-skills-in-nano-claw/).

### What this means in practice

**Skills are config, not codemods.** A skill is a `skill.json` manifest + a `SKILL.md` setup guide. No three-way merges, no generated code, no risk of conflicts between skills.

**Community MCP servers are the ecosystem.** Instead of reimplementing WhatsApp from scratch, Nonnaclaw wraps a community server with 5k+ stars and 12 tools. The community builds and maintains the integrations. Nonnaclaw just bridges them.

**Scoped authorization per group.** Each group declares which skill tools it can access and with what parameter constraints. A family group chat can only send messages to its own JID. The main channel gets unrestricted access. Scoping happens at the proxy layer; the agent never sees tools it isn't allowed to use.

**Everything else stays the same.** Container isolation, filesystem IPC, per-group memory, scheduled tasks, the Claude Agent SDK. All inherited from NanoClaw. Nonnaclaw changes how skills work, not how agents run.

## Architecture

```
skills/whatsapp/                         skills/telegram/
┌──────────────────────┐                ┌──────────────────────┐
│ Community MCP Server │                │ Community MCP Server │
│ (stdio)              │                │ (stdio)              │
└─────────┬────────────┘                └─────────┬────────────┘
          │                                       │
          ▼                                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Host: src/mcp-bridge.ts                                    │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │ WhatsApp Bridge         │  │ Telegram Bridge          │  │
│  │ • StdioClientTransport  │  │ • StdioClientTransport   │  │
│  │ • HTTP endpoint :19700  │  │ • HTTP endpoint :19701   │  │
│  │ • Polls list_messages   │  │ • Polls getUpdates       │  │
│  └─────────────────────────┘  └─────────────────────────┘  │
│                                                             │
│  Orchestrator (src/index.ts)                                │
│  • Message loop, group routing, container spawning          │
│  • IPC watcher, task scheduler, KV store                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (host.docker.internal:PORT/mcp)
                       ▼
┌─ Agent Container ──────────────────────────────────────────┐
│  MCP Proxy (mcp-proxy.ts)                                  │
│  • Connects to host bridge via StreamableHTTPClientTransport│
│  • Applies scopeTemplate: tool allowlists + param pinning  │
│  • Agent only sees tools it's authorized for               │
│                                                            │
│  NanoClaw MCP (ipc-mcp-stdio.ts)                           │
│  • send_message, schedule_task, save_state, etc.           │
│                                                            │
│  Claude Agent SDK                                          │
└────────────────────────────────────────────────────────────┘
```

Single Node.js process on the host. MCP servers run as child processes with stdio transport. The host bridges each one to an HTTP endpoint. Container agents connect through a scoping proxy that enforces per-group authorization. Agents execute in isolated Linux containers (Apple Container or Docker) with only their group's filesystem mounted.

## Skill Anatomy

A skill is a directory under `skills/` with two files:

### `skill.json`: Machine-readable manifest

```json
{
  "name": "whatsapp",
  "version": "2.0.0",
  "description": "WhatsApp channel via lharries/whatsapp-mcp",
  "mcp": {
    "command": "uv",
    "args": ["--directory", "./whatsapp-mcp/whatsapp-mcp-server", "run", "main.py"],
    "pollTool": "list_messages",
    "pollIntervalMs": 3000,
    "pollTimestampArg": "after"
  },
  "scopeTemplate": {
    "send_message": { "allow": true, "scopedParams": ["recipient"] },
    "list_messages": { "allow": true, "scopedParams": ["chat_jid"] },
    "search_contacts": { "allow": true },
    "list_chats": { "allow": false }
  }
}
```

- **`mcp`**: How to spawn the upstream MCP server. The host manages the process lifecycle.
- **`mcp.pollTool`**: If set, the host polls this tool for inbound messages and routes them to registered groups.
- **`scopeTemplate`**: Which tools to expose and which parameters are scoped per-group. Scoped params get pinned to group-specific values (e.g., `recipient` pinned to the group's JID).

### `SKILL.md`: Human-readable setup guide

Instructions that Claude Code follows during `/install`. Covers:
- Cloning dependencies (community MCP server repos)
- Authentication flows (QR codes, OAuth, API keys)
- Registering groups with `authorizedSkills` and pinned parameters
- Verifying the installation works

The skill never touches core source files. It only configures itself and registers groups in SQLite.

## Key Decisions

| Decision | NanoClaw | Nonnaclaw |
|----------|----------|-----------|
| Adding a channel | Claude rewrites `src/index.ts`, `src/router.ts`, etc. | Clone a community MCP server, add `skill.json` |
| Skill format | Claude Code skill (`.claude/skills/`) that generates code | Self-contained package (`skills/`) with manifest + setup guide |
| MCP server lifecycle | Spawned per-container (each agent starts its own) | Persistent on host, shared via HTTP bridge |
| Tool authorization | Application-level checks in generated code | Proxy layer with `scopeTemplate` rules + param pinning |
| Inbound messages | Channel-specific polling code in core | Generic `pollTool` in skill manifest, host polls automatically |
| Skill conflicts | Possible (multiple skills editing same files) | Impossible (skills are additive config, not code patches) |

## Quick Start

```bash
git clone <this-repo>
cd nonnaclaw
claude
```

Then run `/setup`. Claude Code handles dependencies, container setup, and service configuration.

To add a skill:

```
/install https://github.com/nickdirienzo/nonnaclaw-whatsapp
```

Claude clones the repo, reads `SKILL.md`, walks you through auth, registers your groups, and restarts the service.

## What It Supports

- **Any MCP-compatible channel.** WhatsApp, Telegram, Slack, and anything with a community MCP server.
- **Isolated group context.** Each group has its own `CLAUDE.md` memory, isolated filesystem, and container sandbox.
- **Scoped tool access.** Groups only see the tools and parameters they're authorized for.
- **Main channel.** Your private channel for admin control; manages all groups.
- **Scheduled tasks.** Recurring jobs that run Claude and can message you back.
- **Web access.** Search and fetch content from the web.
- **Container isolation.** Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux).
- **Agent Swarms.** Teams of specialized agents collaborating on complex tasks.
- **Filesystem IPC.** Agents communicate with the host via JSON files, no network needed.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/mcp-bridge.ts` | Host-side MCP bridge: spawns servers, exposes HTTP, polls inbound |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/skill-registry.ts` | Discovers skills, generates proxy configs with scoping rules |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations (messages, groups, sessions, state) |
| `container/agent-runner/src/mcp-proxy.ts` | In-container proxy: HTTP upstream + scope enforcement |
| `skills/*/skill.json` | Skill manifests |
| `groups/*/CLAUDE.md` | Per-group agent memory |

## Ancestry

Nonnaclaw is a fork of [NanoClaw](https://github.com/qwibitai/NanoClaw) by [Gavriel Cohen](https://github.com/gavrielco) and wouldn't exist without it. NanoClaw's core insight is that a personal AI assistant should be small enough to understand, secure by isolation, and customizable by rewriting code. That's the foundation everything here builds on. The container model, filesystem IPC, per-group isolation, the Claude Agent SDK harness, the entire runtime: all NanoClaw.

What Nonnaclaw changes is narrow: how skills are packaged and how channels are added. NanoClaw's "skills as codemods" model is elegant and works well for a single-user fork. Nonnaclaw experiments with an alternative. Skills as self-contained MCP packages that never touch core, aimed at making it possible to compose multiple community-maintained skills without merge conflicts.

This is an experiment. NanoClaw is the real thing. [Go use it](https://github.com/qwibitai/NanoClaw).

## License

MIT
