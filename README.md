# dotbox-bridge

Local daemon that connects your Claude Code agents to the [DotBox](https://dotbox.zip) dashboard. Open-source by design — your code, agents, and Anthropic API key never leave your machine.

Standalone binary (~100MB, Bun runtime baked in) speaks a versioned event protocol over WebSocket.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tylercyert/dotbox-bridge/main/install.sh | bash
```

This downloads the right binary for your OS + arch from the latest GitHub Release and drops it at `~/.local/bin/dotbox`. Override the install location with `DOTBOX_INSTALL_DIR=/usr/local/bin ...`.

Supported platforms: `linux-x64`, `darwin-x64`, `darwin-arm64`. Linux-arm64 falls back to the from-source path.

## Run

```bash
dotbox dev                          # local-only (ws://127.0.0.1:7878)
dotbox dev --host 0.0.0.0           # LAN-accessible (open dashboard from another machine)
dotbox spawn ~/path/to/your/repo    # spawn a claude session in that dir
dotbox config show                  # inspect ~/.dotbox/config.json
dotbox config add-watched-dir ~/foo # whitelist a new directory
dotbox help                         # all commands
```

The DotBox dashboard auto-connects to `ws://<dashboard-hostname>:7878/ws`. Loading the dashboard at `http://blackmetal:5173/app` makes it connect to `ws://blackmetal:7878/ws`. Use `--host 0.0.0.0` if those hostnames differ.

## What the bridge guarantees

- **Path sandboxing** — spawn refuses paths outside `watched_dirs` (defaults to `$HOME`)
- **Privacy default** — paths + sizes + sha256 only on the wire, never file contents
- **Workspace policy** — `blocked_outright` patterns auto-deny without prompting
- **Three-tier escalation** — workspace policy → orchestrator agent → human inbox

## From source

Requires [bun](https://bun.sh).

```bash
git clone https://github.com/tylercyert/dotbox-bridge.git
cd dotbox-bridge
bun install
bun run build           # produces dist/dotbox
./dist/dotbox dev
```

For active development:

```bash
bun run dev               # hot-reload bridge
bun run typecheck         # strict tsc check
```

## Architecture

```
src/
  index.ts             CLI entry — dev, spawn, config, help
  schema.ts            Event + Command type contract — versioned wire format
  config.ts            ~/.dotbox/config.json (bridge_id, watched_dirs, permission_policy)
  transport.ts         Local WebSocket server with event replay buffer
  bridge.ts            Orchestration root — instance registry, three-tier escalation
  process-manager.ts   Spawns claude with stream-json, translates stdout, permission round-trip
  policy.ts            Workspace permission policy matcher
  demo-session.ts      Scripted fake worker for token-free testing
  demo-orchestrator.ts Rule-based orchestrator stand-in
```

`schema.ts` is the **load-bearing contract** between bridge and dashboard. Versioned via `PROTOCOL_VERSION` (currently `1`). Add new event/command kinds without bumping; consumers must ignore unknown kinds. Bump only on incompatible changes.

## Releasing

```bash
git tag v0.0.3
git push --tags
```

GitHub Actions cross-compiles `linux-x64`, `darwin-x64`, `darwin-arm64` from a single Linux runner via `bun build --compile --target=bun-<platform>` and attaches them to a Release. The install script always pulls from the *latest* release, so tagging is enough.
