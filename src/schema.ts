/**
 * The wire contract between bridge and dashboard.
 *
 * Both directions speak JSON. Bridge → dashboard sends `EventEnvelope`s.
 * Dashboard → bridge sends `CommandEnvelope`s.
 *
 * Versioned via the top-level `v` field. Bump on incompatible changes.
 * Add new EventKinds or CommandKinds without bumping; consumers must ignore unknown kinds.
 */

export const PROTOCOL_VERSION = 1 as const

// ============================================================================
// Events: bridge → dashboard
// ============================================================================

export type Event =
  // Bridge lifecycle
  | { kind: 'bridge.connected'; payload: BridgeConnectedPayload }
  | { kind: 'bridge.disconnected'; payload: { reason: string } }
  | { kind: 'bridge.heartbeat'; payload: { watched_dirs: string[]; active_instances: number } }

  // Instance lifecycle
  | { kind: 'instance.spawned'; payload: InstanceSpawnedPayload }
  | { kind: 'instance.session_started'; payload: { claude_session_id: string; jsonl_path: string } }
  | { kind: 'instance.session_ended'; payload: SessionEndedPayload }
  | { kind: 'instance.idle'; payload: { since_ts: string; last_activity_kind: string } }
  | { kind: 'instance.blocked'; payload: { reason: 'awaiting_approval' | 'awaiting_user' | 'awaiting_tool' } }
  | { kind: 'instance.crashed'; payload: { exit_code: number | null; stderr_tail: string } }
  | { kind: 'instance.collision'; payload: { conflicting_instance_id: string; working_dir: string } }

  // Conversation
  | { kind: 'prompt.user'; payload: { text: string; source: 'dashboard' | 'local_stdin' | 'hook' } }
  | { kind: 'prompt.assistant.delta'; payload: { text_delta: string; msg_id: string; index: number } }
  | { kind: 'prompt.assistant.complete'; payload: AssistantCompletePayload }
  | { kind: 'prompt.thinking.delta'; payload: { text_delta: string; msg_id: string; index: number } }

  // Tools
  | { kind: 'tool.call.requested'; payload: { tool_call_id: string; tool_name: string; tool_input: unknown } }
  | { kind: 'tool.call.completed'; payload: ToolCallCompletedPayload }
  | { kind: 'tool.call.failed'; payload: { tool_call_id: string; error: string } }

  // Filesystem (paths only — content never streamed unless explicitly requested)
  | { kind: 'file.write'; payload: FileWritePayload }
  | { kind: 'file.read'; payload: { path: string; size_bytes: number; source: 'agent' | 'user' } }
  | { kind: 'file.delete'; payload: { path: string } }

  // Approvals
  | { kind: 'approval.requested'; payload: ApprovalRequestedPayload }
  | { kind: 'approval.granted'; payload: ApprovalDecisionPayload }
  | { kind: 'approval.denied'; payload: ApprovalDecisionPayload }
  | { kind: 'approval.timed_out'; payload: { request_id: string; after_ms: number } }

  // Hooks (when --include-hook-events is on)
  | { kind: 'hook.fired'; payload: HookFiredPayload }

  // Cost telemetry
  | { kind: 'usage.delta'; payload: UsageDeltaPayload }

  // RPC responses (request_id correlates with the originating command envelope id)
  | { kind: 'directory.listing'; payload: DirectoryListingPayload }

  // Workspace policy
  | { kind: 'policy.updated'; payload: PermissionPolicy }

export type EventKind = Event['kind']

export type EventEnvelope = Event & {
  v: typeof PROTOCOL_VERSION
  id: string                  // ulid (sortable)
  ts: string                  // ISO8601 with ms
  bridge_id: string           // 'local' in Phase 1 dev mode
  workspace_id: string        // 'local' in Phase 1 dev mode
  instance_id: string | null  // null for bridge-level events
  seq: number                 // monotonic per bridge_id, replay key
}

// Payload shapes

export interface BridgeConnectedPayload {
  bridge_version: string
  os: string
  hostname_hint: string
  watched_dirs: string[]
  claude_version: string | null
  /** Initial workspace permission policy. Subsequent changes arrive via policy.updated. */
  permission_policy: PermissionPolicy
}

export interface PermissionPolicy {
  /**
   * Patterns the bridge denies without prompting the user or any orchestrator.
   * Format: `<ToolName>(<arg-substring>)`. Examples:
   *   - "Bash"                       — block all Bash calls
   *   - "Bash(rm -rf )"              — block any Bash with substring "rm -rf "
   *   - "WebFetch(https://evil.com)" — block exact host match
   * Tool name is required; arg pattern is a substring match (case-sensitive)
   * against the JSON-serialised tool input.
   */
  blocked_outright: string[]
  /**
   * Patterns the bridge always escalates to a human, bypassing any orchestrator.
   * Same format as blocked_outright.
   */
  always_require_human: string[]
}

export interface InstanceSpawnedPayload {
  template_id: string | null
  template_version_id: string | null
  claude_session_id: string
  working_dir: string
  model: string
  allowed_tools: string[] | null
  permission_mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /**
   * Parent instance for team scoping. If set, this worker's approval requests
   * route to its nearest-alive orchestrator ancestor, NOT to other orchestrators
   * in the workspace. null = standalone (orchestrators ignore it).
   */
  parent_instance_id: string | null
}

export interface SessionEndedPayload {
  exit_code: number | null
  total_tokens_in: number
  total_tokens_out: number
  cost_usd_estimate: number
  duration_ms: number
}

export interface AssistantCompletePayload {
  text: string
  msg_id: string
  stop_reason: string | null
  tokens_in: number
  tokens_out: number
  thinking_tokens: number | null
}

export interface ToolCallCompletedPayload {
  tool_call_id: string
  duration_ms: number
  ok: boolean
  /** Truncated to ~4 KB. Full result available via `read_tool_result` command. */
  result_preview: string
  result_size_bytes: number
}

export interface FileWritePayload {
  path: string
  size_bytes: number
  sha256: string
  source: 'agent' | 'user'
  diff_summary?: { added: number; removed: number }
}

export interface ApprovalRequestedPayload {
  request_id: string
  tool_name: string
  tool_input: unknown
  requested_by_msg_id: string | null
  permission_mode_hint?: string
}

export interface ApprovalDecisionPayload {
  request_id: string
  decided_by:
    | { kind: 'human'; id: string | null }
    | { kind: 'orchestrator'; id: string }
    | { kind: 'template_allowlist'; id: string }
    | { kind: 'workspace_policy'; id: string }
  reasoning?: string
}

export interface HookFiredPayload {
  event:
    | 'PreToolUse'
    | 'PostToolUse'
    | 'Stop'
    | 'Notification'
    | 'UserPromptSubmit'
    | 'SubagentStop'
    | 'PreCompact'
    | 'SessionStart'
  matcher: string | null
  exit_code: number
  stdout_tail: string
}

export interface UsageDeltaPayload {
  tokens_in: number
  tokens_out: number
  cache_read: number
  cache_write: number
  model: string
  cost_usd_estimate: number
}

export interface DirectoryListingPayload {
  /** Echoes the originating command envelope id. */
  request_id: string
  /** Absolute path that was listed. */
  path: string
  /** Directories first, then files, alphabetical within each group. */
  entries: Array<{ name: string; is_dir: boolean; size_bytes?: number }>
  /** Set if listing failed (path outside watched_dirs, ENOENT, etc). */
  error?: string
}

// ============================================================================
// Commands: dashboard → bridge
// ============================================================================

export type Command =
  | { kind: 'spawn'; payload: SpawnCommandPayload }
  | { kind: 'send_message'; payload: { instance_id: string; text: string } }
  | { kind: 'approve'; payload: { request_id: string; reason?: string } }
  | { kind: 'deny'; payload: { request_id: string; reason?: string } }
  | { kind: 'kill'; payload: { instance_id: string } }
  | { kind: 'interrupt'; payload: { instance_id: string } }
  | { kind: 'read_file'; payload: { instance_id: string; path: string } }
  | { kind: 'read_tool_result'; payload: { instance_id: string; tool_call_id: string } }
  | { kind: 'replay_from'; payload: { since_seq: number } }
  | { kind: 'list_dir'; payload: { path: string } }
  | { kind: 'spawn_demo'; payload: { template?: TemplateSnapshot; parent_instance_id?: string } }
  | { kind: 'update_permission_policy'; payload: PermissionPolicy }

export type CommandKind = Command['kind']

export type CommandEnvelope = Command & {
  v: typeof PROTOCOL_VERSION
  id: string             // ulid; bridge echoes in `command.acked` event
  ts: string
  workspace_id: string
}

export interface SpawnCommandPayload {
  /** Local filesystem path. Must resolve under one of the bridge's watched_dirs. */
  working_dir: string
  /** Optional template snapshot to materialize before spawning. */
  template?: TemplateSnapshot
  /** Override session id (otherwise bridge generates a uuid). */
  session_id?: string
  /** Override allowed_tools (otherwise inherits from template). */
  allowed_tools?: string[]
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /** Spawn this instance as a member of an existing orchestrator's team. */
  parent_instance_id?: string
}

/**
 * Minimal template snapshot for spawning. Mirrors the eventual `template_versions.payload`
 * but kept in this schema so the bridge does not need to know the dashboard's storage model.
 */
export interface TemplateSnapshot {
  template_id: string
  template_version_id: string
  name: string
  role: 'worker' | 'orchestrator'
  model: string
  thinking_budget?: number
  system_prompt?: string
  allowed_tools?: string[]
  mcp_servers?: Record<string, unknown>
  hooks?: Record<string, unknown>
  /** File set to materialize into the working dir before spawn (relative paths). */
  files?: Array<{ path: string; content: string }>
  env?: Record<string, string>
  lifecycle?: TemplateLifecyclePolicy
}

export interface TemplateLifecyclePolicy {
  idle_timeout_ms?: number
  max_session_ms?: number
  max_usd_per_session?: number
  approval_timeout_ms?: number
}

// ============================================================================
// Discriminated payload helper — narrows a kind to its payload type
// ============================================================================

export type PayloadOf<K extends EventKind> = Extract<Event, { kind: K }>['payload']
export type CommandPayloadOf<K extends CommandKind> = Extract<Command, { kind: K }>['payload']
