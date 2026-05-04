import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { PermissionPolicy } from './schema.ts'

export interface BridgeConfig {
  /** Per-install identifier so the dashboard can recognize this bridge across restarts. */
  bridge_id: string
  /** Allowed working directory roots. Spawn refuses paths outside these. */
  watched_dirs: string[]
  /** Override claude binary (default: 'claude' on PATH). */
  claude_path?: string
  /** Workspace-level permission rails. Bridge enforces these without asking the user. */
  permission_policy: PermissionPolicy
}

const CONFIG_DIR = join(homedir(), '.dotbox')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export async function loadConfig(): Promise<BridgeConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return defaultConfig()
  }
  const raw = await readFile(CONFIG_PATH, 'utf8')
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>
  return {
    bridge_id: parsed.bridge_id ?? randomBridgeId(),
    watched_dirs: parsed.watched_dirs ?? [homedir()],
    claude_path: parsed.claude_path,
    permission_policy: parsed.permission_policy ?? { blocked_outright: [], always_require_human: [] },
  }
}

export async function saveConfig(config: BridgeConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true })
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

function defaultConfig(): BridgeConfig {
  return {
    bridge_id: randomBridgeId(),
    watched_dirs: [homedir()],
    permission_policy: { blocked_outright: [], always_require_human: [] },
  }
}

function randomBridgeId(): string {
  return 'br_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}
