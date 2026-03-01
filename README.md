# NonnaClaw 🤌

An experimental fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) exploring a skill model that adds capabilities without modifying the code: using MCP servers, filesystem IPC, and scoped authorization instead of code generation.

*Nonna = Italian for grandmother. She runs a tight kitchen.*

---

## Philosophy

NonnaClaw is named after the Italian grandmother who keeps her kitchen *immaculate*. 🤌

**Her kitchen is small, and she knows where everything is.** The core is a handful of files. If you can't read the whole thing in one sitting, something went wrong.

**Every dish gets its own pot.** Skills are self-contained: own repo, own dependencies, own MCP server. You don't dump the pasta water into the risotto.

**You bring ingredients, you follow her system.** Skills talk to core through one contract: a `skill.json` manifest declaring what tools you bring and how to poll for messages. No rearranging her cabinets.

**She decides who touches the good knives.** Each agent only gets the MCP tools explicitly authorized for its group. Nonna holds the credentials, scopes the parameters, and proxies the calls. You get tool results back.

**If it doesn't belong in the kitchen, it stays outside.** MCP servers and inbound polling run on the host (trusted zone). The agent's container is the kitchen: sandboxed, scoped, and under Nonna's supervision.

## How It Differs From NanoClaw

NanoClaw's skill model works by having Claude Code rewrite your fork. Skills are SKILL.md files that generate new TypeScript in your codebase. This is an interesting approach that is only possible due to agentic programming, but it causes:

- **Patch management.** Skills are unversioned and their dependencies pollute everyone. Yes you should only take what you need and tell Claude to remove the rest, but why start with the kitchen sink if you don't have to.
- **Conflicts.** Code and database schema conflicts are resolved through a 3-way merge, but even with Claude, you can end up writing data to the wrong place (I did make a skill for SMTP which ran into some fun issues on the data side).
- **Auditability.** Every skill adds code to core, so the "few thousand lines you can read in one sitting" pitch erodes with each one. After a few skills, you're auditing generated code you didn't write across files you share with other skills.

NonnaClaw takes a different approach:

- **Skills don't touch core code.** A skill is a `skill.json` manifest and a `SKILL.md` setup guide. No codemods, no SQLite migrations in core, no new imports in index.ts.
- **Skills own their own dependencies.** A WhatsApp skill pulls in whatsapp-mcp. A Telegram skill pulls in telegram-mcp. Neither knows about the other. Neither pollutes core.
- **Community MCP servers for everything.** Inbound polling and outbound actions both go through the same upstream MCP server. We don't write NonnaClaw-specific ones. The whole point is to leverage what already exists.
- **Two independent security boundaries.** Container filesystem isolation controls what the agent can see. MCP authorization (via `scopeTemplate`) controls what the agent can do.

## The Experiment

The thesis is that you can add channels to a personal AI assistant without modifying core code. The litmus test: if adding a new channel requires any of these, the model is broken.

- Changing index.ts, router.ts, or db.ts: the event interface is wrong
- Writing a NonnaClaw-specific MCP server: the community reuse pattern is wrong
- Adding dependencies to core package.json: the skill isolation is wrong
- Any SQLite migration in core: the state ownership boundary is wrong

So far, WhatsApp works as a fully external skill: a `skill.json` manifest pointing at a community MCP server, a `SKILL.md` setup guide, and zero lines changed in core. That's one channel. The experiment is whether this holds as more get added.

## Architecture

```
nonnaclaw-skills/whatsapp/               nonnaclaw-skills/telegram/
+----------------------+                +----------------------+
| Community MCP Server |                | Community MCP Server |
| (stdio)              |                | (stdio)              |
+----------+-----------+                +----------+-----------+
           |                                       |
           v                                       v
+-------------------------------------------------------------+
|  Host: src/mcp-bridge.ts                                     |
|  +-------------------------+  +-------------------------+    |
|  | WhatsApp Bridge         |  | Telegram Bridge          |   |
|  | - StdioClientTransport  |  | - StdioClientTransport   |   |
|  | - HTTP endpoint :19700  |  | - HTTP endpoint :19701   |   |
|  | - Polls list_messages   |  | - Polls getUpdates       |   |
|  +-------------------------+  +-------------------------+    |
|                                                              |
|  Orchestrator (src/index.ts)                                 |
|  - Message loop, group routing, container spawning           |
|  - IPC watcher, task scheduler, KV store                     |
|  - Nonna at the pass: routes inbound, dispatches outbound    |
+----------------------------+---------------------------------+
                             | HTTP (host.docker.internal:PORT)
                             v
+-- Agent Container -----------------------------------------------+
|  MCP Proxy (mcp-proxy.ts)                                        |
|  - Connects to host bridge via StreamableHTTPClientTransport     |
|  - Applies scopeTemplate: tool allowlists + param pinning        |
|  - Agent only sees tools it's authorized for                     |
|                                                                  |
|  NanoClaw MCP (ipc-mcp-stdio.ts)                                 |
|  - send_message, schedule_task, save_state, etc.                 |
|                                                                  |
|  Claude Agent SDK                                                |
+------------------------------------------------------------------+
```

Single Node.js process on the host. MCP servers run as child processes with stdio transport. The host bridges each one to an HTTP endpoint. Container agents connect through a scoping proxy that enforces per-group authorization. Agents execute in isolated Linux containers (Apple Container or Docker) with only their group's filesystem mounted.

## Skill Anatomy

A skill is its own git repo, installed as a sibling directory under `nonnaclaw-skills/`. Two files. That's it.

### `skill.json`: Machine-readable manifest

```json
{
  "name": "whatsapp",
  "version": "2.0.0",
  "description": "WhatsApp channel via community MCP server",
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

Instructions that Claude Code follows during `/install`. Covers cloning dependencies, authentication flows, registering groups, and verifying the installation works.

The skill never touches core source files. It only configures itself and registers groups in SQLite.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Filesystem IPC** | Events are files in mounted volumes. No message brokers. The agent should feel like it has its own computer. |
| **MCP bridge polls inbound** | The host's MCP bridge uses `pollTool` to pull new messages generically. Each skill just declares what to poll. No per-skill inbound scripts. |
| **Inbound on host, outbound via host** | If the agent runs its own inbound listener, a compromised agent can forge or filter incoming messages. Outbound goes through the host bridge too — Nonna sees everything that comes in and goes out. |
| **MCP auth broker on host** | The host holds credentials and proxies tool calls. The agent never sees raw tokens. |
| **Community MCP servers for outbound** | Writing NonnaClaw-specific MCP servers defeats the purpose. Use what exists. |

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

Claude clones the repo into `nonnaclaw-skills/`, reads `SKILL.md`, walks you through auth, registers your groups, and restarts the service.

## What It Supports

Inherited from NanoClaw:

- **Isolated group context.** Each group has its own `CLAUDE.md` memory, isolated filesystem, and container sandbox.
- **Main channel.** Your private channel for admin control; manages all groups.
- **Scheduled tasks.** Recurring jobs that run Claude and can message you back.
- **Web access.** Search and fetch content from the web.
- **Container isolation.** Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux).
- **Filesystem IPC.** Agents communicate with the host via JSON files in mounted volumes.

Added by NonnaClaw:

- **Any MCP-compatible channel.** WhatsApp, Telegram, Slack, and anything with a community MCP server.
- **Scoped tool access.** Groups only see the tools and parameters they're authorized for via `scopeTemplate`.

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
| `src/db.ts` | SQLite operations |
| `container/agent-runner/src/mcp-proxy.ts` | In-container proxy: HTTP upstream + scope enforcement |
| `../nonnaclaw-skills/*/skill.json` | Skill manifests (sibling directory) |
| `groups/*/CLAUDE.md` | Per-group agent memory |

## Status

This is experimental. I'm using it to test whether the external skill model actually works in practice.

For the full motivation, see [Exploring External Skills in NanoClaw](https://nickdirienzo.com/exploring-external-skills-in-nano-claw/).

## Ancestry

NonnaClaw is a fork of [NanoClaw](https://github.com/qwibitai/NanoClaw) by [Gavriel Cohen](https://github.com/gavrielc) and wouldn't exist without it. NanoClaw's core insight is that a personal AI assistant should be small enough to understand, secure by isolation, and customizable by rewriting code. That's the foundation everything here builds on.

What NonnaClaw changes is narrow: how skills are packaged and how channels are added. NanoClaw's "skills as codemods" model is elegant and works well for a single-user fork. NonnaClaw experiments with an alternative: skills as self-contained MCP packages that never touch core, aimed at making it possible to compose multiple community-maintained skills without merge conflicts.

This is an experiment. NanoClaw is the real thing. [Go use it](https://github.com/qwibitai/NanoClaw).

## License

MIT
