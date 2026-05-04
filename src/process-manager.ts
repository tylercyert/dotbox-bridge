import { spawn, type Subprocess } from 'bun'
import { ulid } from 'ulid'
import type { Event } from './schema.ts'

export interface ProcessManagerOptions {
  instanceId: string
  workingDir: string
  claudePath: string
  /** Optional explicit session id (otherwise we let claude generate). */
  sessionId?: string
  systemPromptFile?: string
  settingsPath?: string
  mcpConfigPath?: string
  allowedTools?: string[]
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /** Files to write into working_dir before spawning claude. */
  prelude?: Array<{ path: string; content: string }>
  /** Parent orchestrator instance, if this is a team member. */
  parentInstanceId?: string
  onEvent: (event: Event) => void
  onExit: () => void
}

interface PendingApproval {
  request_id: string
  /** Function the bridge calls to send the decision back to claude. */
  resolve: (approved: boolean, reason?: string) => void
}

/**
 * Owns one claude subprocess and translates its stream-json output into Events.
 *
 * Phase 1 scope: spawn → stream events → accept user messages → permission round-trip.
 *
 * The exact wire format for permission decisions in `--permission-mode default` is
 * the load-bearing assumption flagged in the plan as "Day 5 validation." Marked TODOs
 * below are the spots that need empirical verification against a real claude binary.
 */
export class ProcessManager {
  readonly instanceId: string
  readonly workingDir: string
  readonly parentInstanceId: string | null
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private startedAt: number = 0
  private claudeSessionId: string | null = null
  private pendingApprovals = new Map<string, PendingApproval>()
  private aliveFlag = false
  private currentModel: string = 'unknown'
  private accumulatedTokensIn = 0
  private accumulatedTokensOut = 0
  private accumulatedCostUsd = 0

  constructor(private opts: ProcessManagerOptions) {
    this.instanceId = opts.instanceId
    this.workingDir = opts.workingDir
    this.parentInstanceId = opts.parentInstanceId ?? null
  }

  isAlive(): boolean {
    return this.aliveFlag
  }

  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovals.has(requestId)
  }

  async start(): Promise<void> {
    const sessionId = this.opts.sessionId ?? crypto.randomUUID()
    this.claudeSessionId = sessionId

    if (this.opts.prelude) {
      await this.writePrelude(this.opts.prelude)
    }

    const args = this.buildClaudeArgs(sessionId)

    this.startedAt = Date.now()
    this.proc = spawn({
      cmd: [this.opts.claudePath, ...args],
      cwd: this.workingDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    this.aliveFlag = true

    this.opts.onEvent({
      kind: 'instance.spawned',
      payload: {
        template_id: null,
        template_version_id: null,
        claude_session_id: sessionId,
        working_dir: this.workingDir,
        model: this.currentModel,
        allowed_tools: this.opts.allowedTools ?? null,
        permission_mode: this.opts.permissionMode ?? 'default',
        parent_instance_id: this.parentInstanceId,
      },
    })

    this.readStdout(this.proc).catch((err) => {
      console.error(`[pm:${this.instanceId}] stdout reader crashed`, err)
    })
    this.readStderr(this.proc).catch((err) => {
      console.error(`[pm:${this.instanceId}] stderr reader crashed`, err)
    })
    this.proc.exited.then((code) => this.handleExit(code))
  }

  /** Send a user message into the claude session. */
  sendUserMessage(text: string, source: 'dashboard' | 'local_stdin' | 'hook'): void {
    if (!this.proc || !this.proc.stdin) return
    this.opts.onEvent({
      kind: 'prompt.user',
      payload: { text, source },
    })
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    }) + '\n'
    this.proc.stdin.write(line)
  }

  /**
   * Resolve a pending permission request. Bridge.handleCommand calls this when
   * a 'approve' or 'deny' command arrives from the dashboard.
   *
   * TODO[day5]: The exact stdin payload for a permission decision in
   * `--permission-mode default` needs to be confirmed against a live claude.
   * Current best guess: a `control_response` envelope referencing the request_id.
   */
  resolveApproval(requestId: string, approved: boolean, reason?: string): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return
    pending.resolve(approved, reason)
    this.pendingApprovals.delete(requestId)
  }

  interrupt(): void {
    if (!this.proc || !this.proc.stdin) return
    // TODO[day5]: confirm interrupt protocol — likely a control message rather than SIGINT
    const line = JSON.stringify({ type: 'control_request', subtype: 'interrupt' }) + '\n'
    this.proc.stdin.write(line)
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.proc?.kill(signal)
    this.aliveFlag = false
  }

  // ---------------------------------------------------------------------------

  private buildClaudeArgs(sessionId: string): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--include-hook-events',
      '--replay-user-messages',
      '--session-id', sessionId,
      '--permission-mode', this.opts.permissionMode ?? 'default',
    ]
    if (this.opts.systemPromptFile) {
      args.push('--append-system-prompt-file', this.opts.systemPromptFile)
    }
    if (this.opts.settingsPath) {
      args.push('--settings', this.opts.settingsPath)
    }
    if (this.opts.mcpConfigPath) {
      args.push('--mcp-config', this.opts.mcpConfigPath)
    }
    if (this.opts.allowedTools && this.opts.allowedTools.length > 0) {
      args.push('--allowed-tools', this.opts.allowedTools.join(','))
    }
    return args
  }

  private async readStdout(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        this.handleStreamJsonLine(line)
      }
    }
    if (buffer.trim()) this.handleStreamJsonLine(buffer)
  }

  private async readStderr(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      // Phase 1: just log. Phase 2: buffer last 4KB for instance.crashed.
      if (chunk.trim()) console.error(`[pm:${this.instanceId}] stderr:`, chunk.trimEnd())
    }
  }

  /**
   * Translate one line of claude's stream-json output into an Event.
   *
   * Format reference (from CLI `--output-format stream-json --include-partial-messages`):
   *
   *   {"type": "system", "subtype": "init", "session_id": "...", "model": "...", ...}
   *   {"type": "assistant", "message": {"id": "...", "content": [{"type": "text", "text": "..."}], "stop_reason": "..."}, "usage": {...}}
   *   {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "...", "name": "Read", "input": {...}}]}}
   *   {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "...", "content": "..."}]}}
   *   {"type": "result", "subtype": "success", "duration_ms": 1234, "total_cost_usd": 0.01, "usage": {...}}
   *
   * TODO[day5]: confirm exact shape of permission_request events in default mode.
   */
  private handleStreamJsonLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[pm:${this.instanceId}] bad stream-json line:`, line.slice(0, 200))
      return
    }

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.currentModel = msg.model ?? this.currentModel
          this.opts.onEvent({
            kind: 'instance.session_started',
            payload: {
              claude_session_id: msg.session_id ?? this.claudeSessionId ?? '',
              jsonl_path: msg.jsonl_path ?? '',
            },
          })
        }
        return
      }
      case 'assistant': {
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'text') {
            this.opts.onEvent({
              kind: 'prompt.assistant.complete',
              payload: {
                text: block.text ?? '',
                msg_id: msg.message?.id ?? '',
                stop_reason: msg.message?.stop_reason ?? null,
                tokens_in: msg.usage?.input_tokens ?? 0,
                tokens_out: msg.usage?.output_tokens ?? 0,
                thinking_tokens: msg.usage?.thinking_tokens ?? null,
              },
            })
          } else if (block.type === 'tool_use') {
            this.opts.onEvent({
              kind: 'tool.call.requested',
              payload: {
                tool_call_id: block.id,
                tool_name: block.name,
                tool_input: block.input,
              },
            })
          } else if (block.type === 'thinking') {
            this.opts.onEvent({
              kind: 'prompt.thinking.delta',
              payload: {
                text_delta: block.thinking ?? '',
                msg_id: msg.message?.id ?? '',
                index: 0,
              },
            })
          }
        }
        if (msg.usage) {
          this.accumulatedTokensIn += msg.usage.input_tokens ?? 0
          this.accumulatedTokensOut += msg.usage.output_tokens ?? 0
        }
        return
      }
      case 'user': {
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
            this.opts.onEvent({
              kind: 'tool.call.completed',
              payload: {
                tool_call_id: block.tool_use_id,
                duration_ms: 0, // not in stream-json; could be timed externally
                ok: !block.is_error,
                result_preview: truncate(resultText, 4096),
                result_size_bytes: resultText.length,
              },
            })
          }
        }
        return
      }
      case 'result': {
        if (typeof msg.total_cost_usd === 'number') {
          this.accumulatedCostUsd = msg.total_cost_usd
        }
        return
      }
      case 'control_request': {
        // TODO[day5]: validate. Tentative shape:
        // {"type": "control_request", "request_id": "...", "subtype": "permission_request",
        //  "tool_name": "Bash", "input": {...}, "msg_id": "..."}
        if (msg.subtype === 'permission_request') {
          const requestId = msg.request_id ?? ulid().toLowerCase()
          this.opts.onEvent({
            kind: 'approval.requested',
            payload: {
              request_id: requestId,
              tool_name: msg.tool_name ?? 'unknown',
              tool_input: msg.input,
              requested_by_msg_id: msg.msg_id ?? null,
            },
          })
          this.opts.onEvent({
            kind: 'instance.blocked',
            payload: { reason: 'awaiting_approval' },
          })
          this.pendingApprovals.set(requestId, {
            request_id: requestId,
            resolve: (approved, reason) => {
              const decision = JSON.stringify({
                type: 'control_response',
                request_id: requestId,
                response: { approved, reason: reason ?? null },
              }) + '\n'
              this.proc?.stdin?.write(decision)
              this.opts.onEvent({
                kind: approved ? 'approval.granted' : 'approval.denied',
                payload: {
                  request_id: requestId,
                  decided_by: { kind: 'human', id: null },
                  reasoning: reason,
                },
              })
            },
          })
        }
        return
      }
      case 'hook_event': {
        this.opts.onEvent({
          kind: 'hook.fired',
          payload: {
            event: msg.event ?? 'PreToolUse',
            matcher: msg.matcher ?? null,
            exit_code: msg.exit_code ?? 0,
            stdout_tail: truncate(msg.stdout ?? '', 1024),
          },
        })
        return
      }
      default:
        // Ignore unknown event types — claude versions may add new ones.
        return
    }
  }

  private handleExit(code: number | null): void {
    this.aliveFlag = false
    this.opts.onEvent({
      kind: 'instance.session_ended',
      payload: {
        exit_code: code,
        total_tokens_in: this.accumulatedTokensIn,
        total_tokens_out: this.accumulatedTokensOut,
        cost_usd_estimate: this.accumulatedCostUsd,
        duration_ms: Date.now() - this.startedAt,
      },
    })
    this.opts.onExit()
  }

  private async writePrelude(prelude: Array<{ path: string; content: string }>): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    for (const file of prelude) {
      const abs = join(this.workingDir, file.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[${text.length - max} bytes truncated]`
}
