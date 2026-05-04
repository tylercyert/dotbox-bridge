#!/usr/bin/env bun
import { loadConfig, saveConfig } from './config.ts'
import { Bridge } from './bridge.ts'

const HELP = `dotbox bridge — local daemon for the DotBox dashboard

USAGE:
  dotbox dev [--port 7878] [--host 127.0.0.1]
      Start the local WS server. Open the dashboard at http://localhost:5173/app.

  dotbox spawn <working-dir>
      Spawn a claude session in the given directory. Requires the daemon to be running.

  dotbox config show
  dotbox config add-watched-dir <path>
      Inspect or modify ~/.dotbox/config.json.

  dotbox help
      Show this message.
`

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv

  switch (cmd) {
    case 'dev':
    case undefined: {
      const port = readFlag(rest, '--port', '7878')
      const host = readFlag(rest, '--host', '127.0.0.1')
      const config = await loadConfig()
      const bridge = new Bridge(config, { port: Number(port), hostname: host })
      bridge.start()
      console.log(`bridge_id: ${config.bridge_id}`)
      console.log(`watched_dirs: ${config.watched_dirs.join(', ')}`)
      console.log('Press Ctrl+C to stop.')
      return
    }
    case 'spawn': {
      const workingDir = rest[0]
      if (!workingDir) {
        console.error('usage: dotbox spawn <working-dir>')
        process.exit(2)
      }
      const port = readFlag(rest.slice(1), '--port', '7878')
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' })
      if (!res.ok) {
        console.error(`bridge not reachable on port ${port}. Start it with: dotbox dev`)
        process.exit(1)
      }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = (e) => reject(e)
      })
      ws.send(JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        workspace_id: 'local',
        kind: 'spawn',
        payload: { working_dir: workingDir },
      }))
      console.log(`spawn requested for ${workingDir}. See dashboard for live events.`)
      setTimeout(() => ws.close(), 250)
      return
    }
    case 'config': {
      const sub = rest[0]
      const config = await loadConfig()
      if (sub === 'show' || !sub) {
        console.log(JSON.stringify(config, null, 2))
        return
      }
      if (sub === 'add-watched-dir') {
        const dir = rest[1]
        if (!dir) {
          console.error('usage: dotbox config add-watched-dir <path>')
          process.exit(2)
        }
        if (!config.watched_dirs.includes(dir)) {
          config.watched_dirs.push(dir)
          await saveConfig(config)
          console.log(`added ${dir}`)
        } else {
          console.log(`${dir} already in watched_dirs`)
        }
        return
      }
      console.error(`unknown subcommand: config ${sub}`)
      process.exit(2)
      return
    }
    case 'help':
    case '--help':
    case '-h': {
      console.log(HELP)
      return
    }
    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exit(2)
  }
}

function readFlag(args: string[], name: string, fallback: string): string {
  const idx = args.indexOf(name)
  if (idx === -1 || idx + 1 >= args.length) return fallback
  return args[idx + 1]
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err)
  process.exit(1)
})
