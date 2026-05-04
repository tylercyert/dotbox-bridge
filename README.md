# dotbox bridge

Local daemon that connects your Claude Code agents to the DotBox dashboard.
Standalone Bun-based binary (~100MB, runtime baked in). Speaks a versioned
event protocol over WebSocket.

## Install

**Recommended (prebuilt binary):**

```bash
curl -fsSL https://<project>.supabase.co/functions/v1/install | bash
```

(Replace `<project>` with the dotbox Supabase project ref. The dashboard's
empty-state shows the exact URL.)

This downloads the right binary for your OS+arch from Supabase Storage and
drops it at `~/.local/bin/dotbox`. Override with `DOTBOX_INSTALL_DIR=...`.

**From source (contributors):**

```bash
git clone https://github.com/tylercyert/agentmaker.git
cd agentmaker
./scripts/install-bridge.sh
```

Requires [bun](https://bun.sh). Builds the binary locally and installs to
the same `~/.local/bin/dotbox` path.

## Run

```bash
dotbox dev                          # local-only (ws://127.0.0.1:7878)
dotbox dev --host 0.0.0.0           # LAN-accessible (e.g. open dashboard from another machine)
dotbox spawn ~/path/to/your/repo    # spawn a claude session in that dir
dotbox config show                  # inspect ~/.dotbox/config.json
dotbox config add-watched-dir ~/foo # whitelist a new directory
dotbox help                         # all commands
```

The dashboard auto-connects via `ws://<dashboard-hostname>:7878/ws`. Loading
the dashboard at `http://blackmetal:5173/app` makes it connect to
`ws://blackmetal:7878/ws`. Use `--host 0.0.0.0` if those hostnames differ.

## Architecture

```
src/
  index.ts             CLI entry — dev, spawn, config, help
  schema.ts            Event + Command type contract — versioned, shared with web app via @bridge/* alias
  config.ts            ~/.dotbox/config.json (bridge_id, watched_dirs, permission_policy)
  transport.ts         Local WebSocket server with event replay buffer
  bridge.ts            Orchestration root — instance registry, command routing, three-tier escalation
  process-manager.ts   Spawns claude with stream-json, translates stdout, handles permission round-trip
  policy.ts            Workspace permission policy matcher (Bash, Bash(substring) patterns)
  demo-session.ts      Scripted fake worker for token-free testing
  demo-orchestrator.ts Rule-based orchestrator stand-in (real-claude MCP follow-on tracked)
```

The bridge enforces:

- **Path sandboxing**: spawn refuses paths outside `watched_dirs`
- **Privacy default**: paths + sizes + sha256 only on the wire, never file contents
- **Workspace policy**: `blocked_outright` patterns auto-deny without prompting
- **Three-tier escalation**: workspace policy → orchestrator → human inbox

## Develop

```bash
bun install
bun run dev               # hot-reload bridge for development
bun run typecheck         # strict tsc check
bun run build             # produce dist/dotbox standalone binary
```

## Releasing a new binary

Until CI is wired up, releases are manual:

```bash
bun run build                                 # produces dist/dotbox
# Upload dist/dotbox to Supabase Storage as:
#   dotbox-bridge/dotbox-linux-x64
#   dotbox-bridge/dotbox-darwin-arm64
#   dotbox-bridge/dotbox-darwin-x64
# (depending on which platform you built on)
```

The `install` Supabase edge function detects user OS+arch and downloads the
matching object.
