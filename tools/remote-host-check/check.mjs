#!/usr/bin/env node
/**
 * Self-check for the Remote Host Adapter through Tailscale Serve.
 *
 *   node tools/remote-host-check/check.mjs [--base http://127.0.0.1:3090]
 */

import { randomUUID } from 'node:crypto'

let base = 'http://127.0.0.1:3090'
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--base') base = process.argv[++i]
}

const checks = []
let exitCode = 0

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    checks.push({ name, ok: true })
    console.log(`PASS  ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message ?? error) })
    console.log(`FAIL  ${name}: ${String(error?.message ?? error)}`)
    exitCode = 1
  }
}

async function rpc(method, payload) {
  const response = await fetch(`${base}/api/remote/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function wsUrl() {
  return base.replace(/^http/, 'ws') + '/api/remote/events.mux'
}

await check('mobile web is served', async () => {
  const response = await fetch(`${base}/`)
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('DSH Remote')) throw new Error('missing DSH Remote root marker')
})

await check('health returns remote protocol v1', async () => {
  const health = await (await fetch(`${base}/api/health`)).json()
  if (health.protocolVersion !== 1) throw new Error(`protocolVersion=${health.protocolVersion}`)
  if (typeof health.hostId !== 'string') throw new Error('missing hostId')
  if (typeof health.principal?.deviceId !== 'string') throw new Error('missing principal.deviceId')
})

await check('allowlisted RPC host.describe works', async () => {
  const body = await rpc('host.describe', {})
  if (body.result?.ok !== true) throw new Error(JSON.stringify(body.result))
  if (typeof body.result.value.hostId !== 'string') throw new Error('missing hostId in result')
})

await check('privileged settings.describe is forbidden', async () => {
  const body = await rpc('settings.describe', {})
  if (body.result?.ok !== false || body.result.error.code !== 'forbidden') {
    throw new Error(`expected forbidden, got ${JSON.stringify(body.result)}`)
  }
})

await check('normalized event stream emits v1 envelopes', async () => {
  const envelope = await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl())
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no event frame within 8s'))
    }, 8000)
    socket.addEventListener('message', event => {
      try {
        const value = JSON.parse(String(event.data))
        if (value.protocolVersion === 1) {
          clearTimeout(timer)
          socket.close()
          resolve(value)
        }
      } catch {
        // Keep waiting for a valid frame.
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    })
  })
  if (typeof envelope.eventId !== 'string' || typeof envelope.sequence !== 'number') {
    throw new Error(`malformed envelope: ${JSON.stringify(envelope)}`)
  }
})

console.log('')
console.log(`${checks.filter(item => item.ok).length}/${checks.length} Remote Host self-checks passed`)
process.exit(exitCode)
