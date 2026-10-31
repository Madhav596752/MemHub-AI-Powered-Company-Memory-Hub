// A disposable, REAL redis-server process for tests that must prove behaviour against an actual server:
// connection refused, a server that is killed and comes back, OOM write errors, a paused (slow) server.
//
//   const server = await startRedisServer()            // null when the redis-server binary is not installed
//   server.url                                         // redis://127.0.0.1:<port>
//   await server.stop(); await server.start()          // same port, empty data (persistence is off)
//   await server.close()                               // stop + forget
//
// Tests use `redisServerAvailable()` for their { skip } option, so a machine without Redis skips them
// instead of failing. Nothing is written to disk (--save "" --appendonly no) and the server only listens on 127.0.0.1.
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

export function redisServerAvailable() {
  try {
    return spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export const SKIP_NO_REDIS_SERVER = redisServerAvailable() ? false : 'redis-server binary not found (install Redis to run this test)'

// An unused TCP port. (Another process could grab it before it is used; the window is tiny and tests only use it locally.)
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

export async function startRedisServer({ password, port } = {}) {
  if (!redisServerAvailable()) return null
  const usePort = port ?? (await freePort())
  let child = null

  const args = ['--port', String(usePort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--loglevel', 'warning']
  if (password) args.push('--requirepass', password)

  const api = {
    port: usePort,
    url: password ? `redis://:${password}@127.0.0.1:${usePort}` : `redis://127.0.0.1:${usePort}`,
    // Without the password: for tests that need a URL the server will reject.
    urlWithoutPassword: `redis://127.0.0.1:${usePort}`,

    async start() {
      if (child) return
      child = spawn('redis-server', args, { stdio: 'ignore' })
      child.once('exit', () => { child = null })
      for (let i = 0; i < 100; i += 1) {
        if (await canConnect(usePort)) return
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error('redis-server did not start')
    },

    async stop() {
      const current = child
      if (!current) return
      await new Promise((resolve) => {
        current.once('exit', resolve)
        current.kill('SIGKILL') // a crash, not a polite shutdown: clients see the socket die
      })
      child = null
    },

    async close() {
      await api.stop()
    },
  }

  await api.start()
  return api
}
