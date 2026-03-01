# NonnaClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that routes messages to Claude Agent SDK running in containers (Linux VMs). Skills are external repos in the sibling `nonnaclaw-skills/` directory. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/mcp-bridge.ts` | Host-side MCP bridge: spawns servers, exposes HTTP, polls inbound, per-group scope enforcement |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/skill-registry.ts` | Discovers skills, generates proxy configs with scoping rules |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `../nonnaclaw-skills/*/skill.json` | Skill manifests (sibling directory) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, containers, Claude auth, service configuration |
| `/install` | Add a channel or capability by installing an external skill repo |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nonnaclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nonnaclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nonnaclaw  # restart

# Linux (systemd)
systemctl --user start nonnaclaw
systemctl --user stop nonnaclaw
systemctl --user restart nonnaclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
