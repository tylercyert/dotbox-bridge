import type { ServerWebSocket } from 'bun'
import type { CommandEnvelope, EventEnvelope } from './schema.ts'

interface ClientData {
  client_id: string
  /** Last seq this client has acked. -1 means it wants the full backlog. */
  last_acked_seq: number
}

export interface TransportOptions {
  port: number
  hostname: string
  onCommand: (cmd: CommandEnvelope) => Promise<void> | void
  onClientConnected: (clientId: string) => Promise<void> | void
}

/**
 * Phase 1 transport: a local WS server the dashboard connects to directly.
 *
 * In Phase 3 this is replaced by an outbound WS client to ingest.dotbox.zip.
 * Both implementations expose the same broadcast/onCommand surface so the
 * Bridge orchestration class doesn't need to know which is in use.
 */
export class LocalTransport {
  private server: ReturnType<typeof Bun.serve<ClientData>> | null = null
  private clients = new Set<ServerWebSocket<ClientData>>()
  /** Ring buffer of recent events for replay on reconnect. */
  private buffer: EventEnvelope[] = []
  private readonly BUFFER_SIZE = 500

  constructor(private opts: TransportOptions) {}

  start(): void {
    this.server = Bun.serve<ClientData>({
      port: this.opts.port,
      hostname: this.opts.hostname,
      fetch: (req, server) => {
        const url = new URL(req.url)
        if (url.pathname === '/ws') {
          const upgraded = server.upgrade(req, {
            data: {
              client_id: crypto.randomUUID(),
              last_acked_seq: -1,
            },
          })
          if (upgraded) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/health') {
          return Response.json({
            ok: true,
            clients: this.clients.size,
            buffered_events: this.buffer.length,
          })
        }
        return new Response('dotbox bridge', { status: 200 })
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws)
          this.opts.onClientConnected(ws.data.client_id)
        },
        message: async (ws, raw) => {
          const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            console.error('[transport] bad json from client', text.slice(0, 200))
            return
          }
          if (!isCommandEnvelope(parsed)) {
            console.error('[transport] not a command envelope', parsed)
            return
          }
          if (parsed.kind === 'replay_from') {
            this.replayTo(ws, parsed.payload.since_seq)
            return
          }
          try {
            await this.opts.onCommand(parsed)
          } catch (err) {
            console.error('[transport] command failed', parsed.kind, err)
          }
        },
        close: (ws) => {
          this.clients.delete(ws)
        },
      },
    })
    console.log(`[transport] WS server listening on ws://${this.opts.hostname}:${this.opts.port}/ws`)
  }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }

  broadcast(event: EventEnvelope): void {
    this.buffer.push(event)
    if (this.buffer.length > this.BUFFER_SIZE) {
      this.buffer.shift()
    }
    const json = JSON.stringify(event)
    for (const ws of this.clients) {
      ws.send(json)
    }
  }

  private replayTo(ws: ServerWebSocket<ClientData>, sinceSeq: number): void {
    for (const event of this.buffer) {
      if (event.seq > sinceSeq) {
        ws.send(JSON.stringify(event))
      }
    }
  }
}

function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.kind === 'string' && typeof v.id === 'string' && v.v === 1
}
