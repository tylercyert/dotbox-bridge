import { ulid } from 'ulid'
import type { Event, TemplateSnapshot } from './schema.ts'

export interface DemoSessionOptions {
  instanceId: string
  template?: TemplateSnapshot
  parentInstanceId?: string
  onEvent: (event: Event) => void
  onExit: () => void
}

interface PendingApproval {
  request_id: string
  resume: (approved: boolean) => void
}

const DEMO_WORKING_DIR = '/demo/example-repo'

/**
 * A scripted fake session that exercises the full event pipeline without
 * spawning a real `claude` process. Useful for UI iteration. Mimics the
 * ProcessManager surface so Bridge can manage it the same way.
 */
export class DemoSession {
  readonly instanceId: string
  readonly workingDir = DEMO_WORKING_DIR
  readonly parentInstanceId: string | null
  private aliveFlag = true
  private timers: ReturnType<typeof setTimeout>[] = []
  private pendingApprovals = new Map<string, PendingApproval>()
  private startedAt = Date.now()

  constructor(private opts: DemoSessionOptions) {
    this.instanceId = opts.instanceId
    this.parentInstanceId = opts.parentInstanceId ?? null
  }

  isAlive(): boolean {
    return this.aliveFlag
  }

  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovals.has(requestId)
  }

  resolveApproval(requestId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return
    this.opts.onEvent({
      kind: approved ? 'approval.granted' : 'approval.denied',
      payload: {
        request_id: requestId,
        decided_by: { kind: 'human', id: null },
      },
    })
    this.pendingApprovals.delete(requestId)
    pending.resume(approved)
  }

  sendUserMessage(text: string): void {
    this.opts.onEvent({ kind: 'prompt.user', payload: { text, source: 'dashboard' } })
    const reply = `Got it — "${text.slice(0, 60)}"${text.length > 60 ? '…' : ''}. Working on it.`
    this.timers.push(setTimeout(() => {
      if (!this.aliveFlag) return
      this.opts.onEvent({
        kind: 'prompt.assistant.complete',
        payload: { text: reply, msg_id: 'msg_demo_reply', stop_reason: 'end_turn', tokens_in: 12, tokens_out: 18, thinking_tokens: null },
      })
    }, 600))
  }

  interrupt(): void {
    this.kill()
  }

  kill(): void {
    if (!this.aliveFlag) return
    this.aliveFlag = false
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.opts.onEvent({
      kind: 'instance.session_ended',
      payload: {
        exit_code: 0,
        total_tokens_in: 1842,
        total_tokens_out: 614,
        cost_usd_estimate: 0.0234,
        duration_ms: Date.now() - this.startedAt,
      },
    })
    this.opts.onExit()
  }

  start(): void {
    const tmpl = this.opts.template
    this.opts.onEvent({
      kind: 'instance.spawned',
      payload: {
        template_id: tmpl?.template_id ?? null,
        template_version_id: tmpl?.template_version_id ?? null,
        claude_session_id: 'demo-' + ulid().toLowerCase().slice(0, 8),
        working_dir: this.workingDir,
        model: tmpl ? `${tmpl.model} (demo)` : 'claude-sonnet-4-6 (demo)',
        allowed_tools: tmpl?.allowed_tools ?? ['Read', 'Write', 'Edit'],
        permission_mode: 'default',
        parent_instance_id: this.parentInstanceId,
      },
    })

    this.scheduleScript()
  }

  private scheduleScript(): void {
    const at = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(() => { if (this.aliveFlag) fn() }, ms))
    }

    // 1. Session started
    at(300, () => this.opts.onEvent({
      kind: 'instance.session_started',
      payload: { claude_session_id: 'demo', jsonl_path: '/demo/.claude/projects/example/demo.jsonl' },
    }))

    // 2. User prompt
    at(800, () => this.opts.onEvent({
      kind: 'prompt.user',
      payload: { text: 'Read README.md and tell me what this project does.', source: 'dashboard' },
    }))

    // 3. Assistant starts thinking
    at(1500, () => this.opts.onEvent({
      kind: 'tool.call.requested',
      payload: { tool_call_id: 'tc_001', tool_name: 'Read', tool_input: { file_path: '/demo/example-repo/README.md' } },
    }))

    // 4. File read event
    at(1700, () => this.opts.onEvent({
      kind: 'file.read',
      payload: { path: 'README.md', size_bytes: 1842, source: 'agent' },
    }))

    // 5. Tool result
    at(2100, () => this.opts.onEvent({
      kind: 'tool.call.completed',
      payload: {
        tool_call_id: 'tc_001',
        duration_ms: 412,
        ok: true,
        result_preview: '# example-repo\n\nA tiny Node service that exposes /healthz and /metrics.\nUses Express, Pino for structured logs, and Prometheus for metrics.\n\n## Quick start\n```bash\nnpm install\nnpm run dev\n```',
        result_size_bytes: 1842,
      },
    }))

    // 6. Assistant response
    at(2900, () => this.opts.onEvent({
      kind: 'prompt.assistant.complete',
      payload: {
        text: 'This is `example-repo` — a small Node/Express HTTP service that exposes two endpoints:\n\n- `/healthz` for liveness probes\n- `/metrics` for Prometheus scraping\n\nIt uses Pino for structured logging. The dev workflow is `npm install` then `npm run dev`.',
        msg_id: 'msg_demo_1',
        stop_reason: 'end_turn',
        tokens_in: 1284,
        tokens_out: 89,
        thinking_tokens: null,
      },
    }))

    // 7. Second user prompt (auto-injected to demo more events)
    at(4000, () => this.opts.onEvent({
      kind: 'prompt.user',
      payload: { text: 'Run `curl https://api.example.com/version` to check the upstream.', source: 'dashboard' },
    }))

    // 8. Tool call requiring approval
    at(4800, () => {
      const tcId = 'tc_002'
      this.opts.onEvent({
        kind: 'tool.call.requested',
        payload: { tool_call_id: tcId, tool_name: 'Bash', tool_input: { command: 'curl https://api.example.com/version' } },
      })
      this.scheduleApprovalRequest(tcId)
    })
  }

  private scheduleApprovalRequest(toolCallId: string): void {
    const requestId = 'apr_' + ulid().toLowerCase().slice(0, 8)
    this.opts.onEvent({
      kind: 'approval.requested',
      payload: {
        request_id: requestId,
        tool_name: 'Bash',
        tool_input: { command: 'curl https://api.example.com/version' },
        requested_by_msg_id: 'msg_demo_2',
      },
    })
    this.opts.onEvent({
      kind: 'instance.blocked',
      payload: { reason: 'awaiting_approval' },
    })
    this.pendingApprovals.set(requestId, {
      request_id: requestId,
      resume: (approved) => this.continueAfterApproval(approved, toolCallId),
    })
  }

  private continueAfterApproval(approved: boolean, toolCallId: string): void {
    const at = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(() => { if (this.aliveFlag) fn() }, ms))
    }

    if (!approved) {
      at(400, () => this.opts.onEvent({
        kind: 'tool.call.failed',
        payload: { tool_call_id: toolCallId, error: 'Permission denied by user.' },
      }))
      at(1100, () => this.opts.onEvent({
        kind: 'prompt.assistant.complete',
        payload: {
          text: "Understood — I won't run that command. Let me know if you'd like me to do something else.",
          msg_id: 'msg_demo_3',
          stop_reason: 'end_turn',
          tokens_in: 320,
          tokens_out: 24,
          thinking_tokens: null,
        },
      }))
      at(2000, () => this.kill())
      return
    }

    at(600, () => this.opts.onEvent({
      kind: 'tool.call.completed',
      payload: {
        tool_call_id: toolCallId,
        duration_ms: 487,
        ok: true,
        result_preview: '{"version":"3.14.2","commit":"a7f3b9c","built_at":"2026-04-12T10:34:11Z"}',
        result_size_bytes: 78,
      },
    }))

    at(900, () => this.opts.onEvent({
      kind: 'tool.call.requested',
      payload: { tool_call_id: 'tc_003', tool_name: 'Write', tool_input: { file_path: '/demo/example-repo/UPSTREAM_VERSION.md', content: '# Upstream version\n\n3.14.2 (a7f3b9c)\n' } },
    }))

    at(1100, () => this.opts.onEvent({
      kind: 'file.write',
      payload: { path: 'UPSTREAM_VERSION.md', size_bytes: 36, sha256: 'demo-sha', source: 'agent' },
    }))

    at(1400, () => this.opts.onEvent({
      kind: 'tool.call.completed',
      payload: { tool_call_id: 'tc_003', duration_ms: 31, ok: true, result_preview: 'File written.', result_size_bytes: 13 },
    }))

    at(2000, () => this.opts.onEvent({
      kind: 'prompt.assistant.complete',
      payload: {
        text: 'Upstream is on **3.14.2** (commit `a7f3b9c`, built 2026-04-12). I wrote that to `UPSTREAM_VERSION.md` for reference.',
        msg_id: 'msg_demo_4',
        stop_reason: 'end_turn',
        tokens_in: 410,
        tokens_out: 38,
        thinking_tokens: null,
      },
    }))

    at(3200, () => this.kill())
  }
}
