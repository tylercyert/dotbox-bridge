import { ulid } from 'ulid'
import { hostname, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type {
  CommandEnvelope,
  Event,
  EventEnvelope,
} from './schema.ts'
import { PROTOCOL_VERSION } from './schema.ts'
import type { BridgeConfig } from './config.ts'
import { saveConfig } from './config.ts'
import { LocalTransport } from './transport.ts'
import { ProcessManager } from './process-manager.ts'
import { DemoSession } from './demo-session.ts'
import { DemoOrchestrator } from './demo-orchestrator.ts'
import { evaluatePolicy } from './policy.ts'
import type { ApprovalRequestedPayload } from './schema.ts'

const BRIDGE_VERSION = '0.0.1'
const WORKSPACE_ID_LOCAL = 'local'

/**
 * The orchestration root. Owns the transport, instance registry, and seq counter.
 * Routes incoming commands to the right ProcessManager and emits events back.
 */
type ManagedSession = ProcessManager | DemoSession | DemoOrchestrator

/** Common surface for parent lookup across all session kinds. */
function parentOf(session: ManagedSession): string | null {
  return session.parentInstanceId
}

export class Bridge {
  private transport: LocalTransport
  private instances = new Map<string, ManagedSession>()
  private seq = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: BridgeConfig,
    opts: { port: number; hostname: string },
  ) {
    this.transport = new LocalTransport({
      port: opts.port,
      hostname: opts.hostname,
      onCommand: (cmd) => this.handleCommand(cmd),
      onClientConnected: () => this.sendBridgeConnected(),
    })
  }

  start(): void {
    this.transport.start()
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 5_000)
    process.on('SIGINT', () => this.shutdown())
    process.on('SIGTERM', () => this.shutdown())
  }

  shutdown(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const pm of this.instances.values()) {
      pm.kill('SIGTERM')
    }
    this.transport.stop()
    process.exit(0)
  }

  /** Spawn a fresh claude session in the given working dir. */
  async spawn(
    workingDir: string,
    template?: import('./schema.ts').TemplateSnapshot,
    parentInstanceId?: string,
  ): Promise<string> {
    const absWorkingDir = resolve(workingDir)
    if (!this.isPathAllowed(absWorkingDir)) {
      throw new Error(
        `working_dir ${absWorkingDir} is outside watched_dirs (${this.config.watched_dirs.join(', ')})`,
      )
    }

    // Collision check
    for (const pm of this.instances.values()) {
      if (pm.workingDir === absWorkingDir && pm.isAlive()) {
        this.emit({
          kind: 'instance.collision',
          payload: {
            conflicting_instance_id: pm.instanceId,
            working_dir: absWorkingDir,
          },
        }, pm.instanceId)
        // Don't refuse — the plan calls for warn-not-block. Caller can decide.
      }
    }

    // If a template was supplied, materialize its system prompt into the working
    // dir so we can pass it to claude via --append-system-prompt-file.
    let systemPromptFile: string | undefined
    if (template?.system_prompt && template.system_prompt.trim().length > 0) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dotboxDir = join(absWorkingDir, '.dotbox')
      await mkdir(dotboxDir, { recursive: true })
      systemPromptFile = join(dotboxDir, 'system-prompt.md')
      await writeFile(systemPromptFile, template.system_prompt, 'utf8')
    }

    const instanceId = 'inst_' + ulid().toLowerCase()
    const pm = new ProcessManager({
      instanceId,
      workingDir: absWorkingDir,
      claudePath: this.config.claude_path ?? 'claude',
      systemPromptFile,
      allowedTools: template?.allowed_tools,
      parentInstanceId,
      onEvent: (event) => this.emit(event, instanceId),
      onExit: () => {
        this.instances.delete(instanceId)
      },
    })
    this.instances.set(instanceId, pm)
    await pm.start()
    return instanceId
  }

  private async handleCommand(cmd: CommandEnvelope): Promise<void> {
    switch (cmd.kind) {
      case 'spawn': {
        await this.spawn(cmd.payload.working_dir, cmd.payload.template, cmd.payload.parent_instance_id)
        return
      }
      case 'send_message': {
        const pm = this.instances.get(cmd.payload.instance_id)
        if (!pm) return
        pm.sendUserMessage(cmd.payload.text, 'dashboard')
        return
      }
      case 'approve': {
        for (const pm of this.instances.values()) {
          if (pm.hasPendingApproval(cmd.payload.request_id)) {
            pm.resolveApproval(cmd.payload.request_id, true, cmd.payload.reason)
            return
          }
        }
        return
      }
      case 'deny': {
        for (const pm of this.instances.values()) {
          if (pm.hasPendingApproval(cmd.payload.request_id)) {
            pm.resolveApproval(cmd.payload.request_id, false, cmd.payload.reason)
            return
          }
        }
        return
      }
      case 'kill': {
        const pm = this.instances.get(cmd.payload.instance_id)
        pm?.kill('SIGTERM')
        return
      }
      case 'interrupt': {
        const pm = this.instances.get(cmd.payload.instance_id)
        pm?.interrupt()
        return
      }
      case 'list_dir': {
        await this.handleListDir(cmd.id, cmd.payload.path)
        return
      }
      case 'spawn_demo': {
        this.spawnDemo(cmd.payload.template, cmd.payload.parent_instance_id)
        return
      }
      case 'update_permission_policy': {
        this.config.permission_policy = cmd.payload
        await saveConfig(this.config)
        this.emit({ kind: 'policy.updated', payload: cmd.payload }, null)
        return
      }
      default:
        // read_file, read_tool_result, replay_from handled in Phase 2+
        return
    }
  }

  /** Scripted fake session for UI iteration without running claude. */
  spawnDemo(template?: import('./schema.ts').TemplateSnapshot, parentInstanceId?: string): string {
    const instanceId = (template?.role === 'orchestrator' ? 'inst_orch_' : 'inst_demo_') + ulid().toLowerCase().slice(0, 6)
    if (template?.role === 'orchestrator') {
      const orch = new DemoOrchestrator({
        instanceId,
        template,
        parentInstanceId,
        onEvent: (event) => this.emit(event, instanceId),
        onExit: () => this.instances.delete(instanceId),
      })
      this.instances.set(instanceId, orch)
      orch.start()
      return instanceId
    }
    const demo = new DemoSession({
      instanceId,
      template,
      parentInstanceId,
      onEvent: (event) => this.emit(event, instanceId),
      onExit: () => this.instances.delete(instanceId),
    })
    this.instances.set(instanceId, demo)
    demo.start()
    return instanceId
  }

  /**
   * Walk up the parent chain from `instanceId` and return the closest alive
   * orchestrator ancestor, or null if there isn't one. Workers without a
   * parent_instance_id never claim a workspace orchestrator — team membership
   * is explicit and team-scoped.
   */
  private orchestratorForTeamOf(instanceId: string): DemoOrchestrator | null {
    const seen = new Set<string>()
    let current: ManagedSession | undefined = this.instances.get(instanceId)
    while (current) {
      const parent = parentOf(current)
      if (!parent || seen.has(parent)) return null
      seen.add(parent)
      const next = this.instances.get(parent)
      if (!next) return null
      if (next instanceof DemoOrchestrator && next.isAlive()) return next
      current = next
    }
    return null
  }

  private async handleListDir(requestId: string, requestedPath: string): Promise<void> {
    const absPath = requestedPath === '' || requestedPath === '/'
      ? null  // sentinel: caller wants the watched_dirs roots
      : resolve(requestedPath)

    if (absPath === null) {
      // Return watched_dirs as the virtual root listing
      const entries = await Promise.all(
        this.config.watched_dirs.map(async (dir) => {
          const abs = resolve(dir)
          let isDir = true
          try {
            isDir = (await stat(abs)).isDirectory()
          } catch { isDir = false }
          return { name: abs, is_dir: isDir }
        })
      )
      this.emit({
        kind: 'directory.listing',
        payload: { request_id: requestId, path: '', entries },
      }, null)
      return
    }

    if (!this.isPathAllowed(absPath)) {
      this.emit({
        kind: 'directory.listing',
        payload: {
          request_id: requestId,
          path: absPath,
          entries: [],
          error: `path is outside watched_dirs (${this.config.watched_dirs.join(', ')})`,
        },
      }, null)
      return
    }

    try {
      const dirents = await readdir(absPath, { withFileTypes: true })
      const entries = dirents
        .map((d) => ({ name: d.name, is_dir: d.isDirectory() }))
        .sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      this.emit({
        kind: 'directory.listing',
        payload: { request_id: requestId, path: absPath, entries },
      }, null)
    } catch (err) {
      this.emit({
        kind: 'directory.listing',
        payload: {
          request_id: requestId,
          path: absPath,
          entries: [],
          error: err instanceof Error ? err.message : String(err),
        },
      }, null)
    }
  }

  private isPathAllowed(absPath: string): boolean {
    return this.config.watched_dirs.some((root) => {
      const absRoot = resolve(root)
      return absPath === absRoot || absPath.startsWith(absRoot + '/')
    })
  }

  private emit(event: Event, instanceId: string | null): void {
    this.seq += 1
    const envelope: EventEnvelope = {
      ...event,
      v: PROTOCOL_VERSION,
      id: ulid().toLowerCase(),
      ts: new Date().toISOString(),
      bridge_id: this.config.bridge_id,
      workspace_id: WORKSPACE_ID_LOCAL,
      instance_id: instanceId,
      seq: this.seq,
    }
    this.transport.broadcast(envelope)

    // Three-tier escalation for approval requests:
    //   1. workspace blocked_outright       → bridge auto-denies
    //   2. workspace always_require_human   → fall straight through to human inbox
    //   3. active orchestrator              → orchestrator decides (approve/deny/escalate)
    //   4. otherwise                        → human inbox (default broadcast)
    // Source instance's resolveApproval is called for tiers 1 and 3-decided.
    if (event.kind === 'approval.requested' && instanceId) {
      const payload = event.payload as ApprovalRequestedPayload
      const policyDecision = evaluatePolicy(this.config.permission_policy, payload.tool_name, payload.tool_input)
      if (policyDecision.kind === 'blocked') {
        const reason = `workspace policy: ${policyDecision.pattern}`
        this.emit({
          kind: 'approval.denied',
          payload: {
            request_id: payload.request_id,
            decided_by: { kind: 'workspace_policy', id: policyDecision.pattern },
            reasoning: reason,
          },
        }, instanceId)
        const session = this.instances.get(instanceId)
        session?.resolveApproval(payload.request_id, false, reason)
        return
      }
      if (policyDecision.kind === 'force_human') {
        // Fall through to default behavior — request stays in inbox for human.
        return
      }
      const orchestrator = this.orchestratorForTeamOf(instanceId)
      // Don't send the orchestrator's own requests back to itself.
      if (orchestrator && orchestrator.instanceId !== instanceId) {
        const verdict = orchestrator.evaluate(payload)
        if (verdict.decision === 'approve' || verdict.decision === 'deny') {
          const granted = verdict.decision === 'approve'
          this.emit({
            kind: granted ? 'approval.granted' : 'approval.denied',
            payload: {
              request_id: payload.request_id,
              decided_by: { kind: 'orchestrator', id: orchestrator.instanceId },
              reasoning: verdict.reasoning,
            },
          }, instanceId)
          const session = this.instances.get(instanceId)
          session?.resolveApproval(payload.request_id, granted, verdict.reasoning)
        }
        // 'escalate' falls through — request stays in inbox.
      }
    }
  }

  private sendBridgeConnected(): void {
    this.emit({
      kind: 'bridge.connected',
      payload: {
        bridge_version: BRIDGE_VERSION,
        os: `${platform()} ${release()}`,
        hostname_hint: hostname(),
        watched_dirs: this.config.watched_dirs,
        claude_version: null, // populated in Phase 2 by `claude --version` probe
        permission_policy: this.config.permission_policy,
      },
    }, null)
  }

  private sendHeartbeat(): void {
    this.emit({
      kind: 'bridge.heartbeat',
      payload: {
        watched_dirs: this.config.watched_dirs,
        active_instances: this.instances.size,
      },
    }, null)
  }
}
