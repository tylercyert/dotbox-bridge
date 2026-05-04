import { ulid } from 'ulid'
import type { ApprovalRequestedPayload, Event, TemplateSnapshot } from './schema.ts'

export interface DemoOrchestratorOptions {
  instanceId: string
  template?: TemplateSnapshot
  parentInstanceId?: string
  onEvent: (event: Event) => void
  onExit: () => void
}

/**
 * A scripted in-process orchestrator. Stands in for a real Claude-driven
 * orchestrator (Phase 4d follow-on) so we can smoke-test the three-tier
 * escalation architecture (workspace policy → orchestrator → human inbox)
 * without burning Anthropic tokens.
 *
 * Decision policy: rule-based regex over tool_name and tool_input (no claude
 * in the loop). The Bridge sends approval requests via `evaluate(request)` and
 * awaits the decision, so this implements the same `OrchestratorAdapter` surface
 * a real MCP-driven orchestrator will eventually expose.
 *
 *   - "Bash" with destructive substring (rm, sudo, dd) → escalate to human
 *   - any other tool                                   → approve
 *
 * (Permissive on purpose so the demo clearly exercises the auto-approve path;
 *  real-claude orchestrators will read their own CLAUDE.md policy doc instead.)
 */
export class DemoOrchestrator {
  readonly instanceId: string
  readonly workingDir = '/demo/orchestrator'
  readonly role: 'orchestrator' = 'orchestrator'
  readonly parentInstanceId: string | null
  private aliveFlag = true
  private startedAt = Date.now()
  private decisionsMade = 0

  constructor(private opts: DemoOrchestratorOptions) {
    this.instanceId = opts.instanceId
    this.parentInstanceId = opts.parentInstanceId ?? null
  }

  isAlive(): boolean {
    return this.aliveFlag
  }

  hasPendingApproval(): boolean {
    return false // orchestrators don't themselves get prompted; their requests they answer
  }

  resolveApproval(): void {
    // no-op — orchestrators don't have pending approvals against themselves
  }

  sendUserMessage(text: string): void {
    // For now, echo the message back as a demo assistant turn.
    this.opts.onEvent({ kind: 'prompt.user', payload: { text, source: 'dashboard' } })
    setTimeout(() => {
      if (!this.aliveFlag) return
      this.opts.onEvent({
        kind: 'prompt.assistant.complete',
        payload: {
          text: `Demo orchestrator: I evaluate approval requests automatically. So far I've made ${this.decisionsMade} decision${this.decisionsMade === 1 ? '' : 's'}.`,
          msg_id: 'msg_orch_' + ulid().toLowerCase().slice(0, 6),
          stop_reason: 'end_turn',
          tokens_in: 14,
          tokens_out: 22,
          thinking_tokens: null,
        },
      })
    }, 400)
  }

  interrupt(): void {
    this.kill()
  }

  kill(): void {
    if (!this.aliveFlag) return
    this.aliveFlag = false
    this.opts.onEvent({
      kind: 'instance.session_ended',
      payload: {
        exit_code: 0,
        total_tokens_in: 0,
        total_tokens_out: this.decisionsMade * 14,
        cost_usd_estimate: 0,
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
        claude_session_id: 'demo-orch-' + ulid().toLowerCase().slice(0, 8),
        working_dir: this.workingDir,
        model: 'demo-orchestrator (rule-based)',
        allowed_tools: null,
        permission_mode: 'default',
        parent_instance_id: this.parentInstanceId,
      },
    })
    this.opts.onEvent({
      kind: 'instance.session_started',
      payload: { claude_session_id: 'demo-orch', jsonl_path: '/demo/.claude/orchestrator.jsonl' },
    })
    this.opts.onEvent({
      kind: 'prompt.assistant.complete',
      payload: {
        text: 'Orchestrator online. Watching for approval requests. Policy: auto-approve read-only tools (Read/Glob/Grep), escalate Bash and everything else to human.',
        msg_id: 'msg_orch_init',
        stop_reason: 'end_turn',
        tokens_in: 0,
        tokens_out: 0,
        thinking_tokens: null,
      },
    })
  }

  /**
   * Decide on an approval request. Returns the decision; the bridge applies it
   * and emits the appropriate events.
   */
  evaluate(request: ApprovalRequestedPayload): {
    decision: 'approve' | 'deny' | 'escalate'
    reasoning: string
  } {
    this.decisionsMade += 1
    const serialized = typeof request.tool_input === 'string'
      ? request.tool_input
      : JSON.stringify(request.tool_input)
    const dangerous = /\b(rm\s+-rf|sudo|dd\s+if=|mkfs|chown\s+-R)\b/.test(serialized)
    if (dangerous) {
      return { decision: 'escalate', reasoning: 'demo policy: destructive command pattern detected, escalating' }
    }
    return { decision: 'approve', reasoning: `demo policy: ${request.tool_name} call looks routine, approving` }
  }
}
