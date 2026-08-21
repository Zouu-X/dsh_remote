#!/usr/bin/env node
/**
 * Connectivity test for exposing DeepSeek Harness through Tailscale Serve.
 *
 * Read-only by default. It exercises the exact loopback surface that
 * Tailscale Serve will proxy later:
 *   - web UI and PWA manifest
 *   - unary HTTP RPC envelope
 *   - the two downlink-only WebSocket endpoints
 *   - loopback-only RPC lockdown when pointed at a non-loopback authority
 *
 * Usage:
 *   node tools/harness-connectivity/connectivity-check.mjs
 *   node tools/harness-connectivity/connectivity-check.mjs --base https://your-mac.your-tailnet.ts.net
 *
 * The script never prints API keys or credential contents.
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'

const args = process.argv.slice(2)
let base = 'http://127.0.0.1:3080'
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base') {
    base = args[++i]
    if (!base) failUsage('--base requires a URL')
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(helpText())
    process.exit(0)
  } else {
    failUsage(`unknown argument: ${args[i]}`)
  }
}

const checks = []

function failUsage(message) {
  console.error(`error: ${message}\n${helpText()}`)
  process.exit(2)
}

function helpText() {
  return `Usage: node tools/harness-connectivity/connectivity-check.mjs [--base <url>]

Defaults to http://127.0.0.1:3080. Point --base at the Tailscale Serve
authority after it is configured and Harness is restarted with --trusted-host.
`
}

function normalizeBase(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function isLoopbackAuthority(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

async function main() {
  base = normalizeBase(base)
  console.log(`DeepSeek Harness connectivity test against ${base}`)
  console.log(`loopback authority: ${isLoopbackAuthority(base)}`)
  console.log('')

  await check('GET / returns the web UI', async () => {
    const response = await fetchWithTimeout(`${base}/`, 10000)
    assertHttp(response, 200)
    const text = await response.text()
    assert(text.length > 500, `expected an HTML document, got ${text.length} bytes`)
    assert(text.includes('__DSH_BOOT__') || text.includes('dsh'), 'expected dsh boot markers in HTML')
  })

  await check('GET /manifest.webmanifest returns the PWA manifest', async () => {
    const response = await fetchWithTimeout(`${base}/manifest.webmanifest`, 10000)
    assertHttp(response, 200)
    const contentType = response.headers.get('content-type') ?? ''
    assert(contentType.includes('manifest'), `unexpected content-type: ${contentType}`)
    const manifest = await response.json()
    assert(manifest && typeof manifest === 'object', 'manifest is not a JSON object')
  })

  for (const method of ['host.describe', 'workspace.list', 'session.list', 'llm.providers']) {
    await check(`RPC ${method}`, async () => {
      const envelope = await rpc(base, method, {})
      assert(envelope.result.ok === true, `RPC failed: ${JSON.stringify(envelope.result)}`)
      assert(envelope.result.value !== undefined, 'RPC ok but value is missing')
    })
  }

  await check('WebSocket /api/events.mux opens and delivers at least one frame', async () => {
    const frame = await wsFirstFrame(base, '/api/events.mux', 8000)
    assert(frame !== undefined, 'socket opened but no frame arrived')
    assert(frame.type === 'server-request', `unexpected frame type: ${frame.type}`)
  })

  await check('WebSocket /api/events.host upgrades successfully', async () => {
    const opened = await wsUpgrade(base, '/api/events.host', 5000)
    assert(opened, 'WebSocket upgrade did not complete')
  })

  if (isLoopbackAuthority(base)) {
    await check('browser-trust fence rejects an undeclared Host authority', async () => {
      const status = await rawHttpStatus(base, 'a0-undeclared.example.com')
      assert(
        status === 403,
        `expected HTTP 403 for undeclared Host, got ${status}`,
      )
    })
  }

  await check('privileged RPC lockdown matches authority', async () => {
    // settings.describe is pinned loopback-only. Over the remote Tailscale
    // authority it must not return a successful result.
    const method = 'settings.describe'
    const envelope = await rpc(base, method, {})
    if (isLoopbackAuthority(base)) {
      assert(envelope.result.ok === true, `expected ${method} to work on loopback`)
    } else {
      assert(
        envelope.result.ok !== true,
        `SECURITY: ${method} must stay loopback-only but returned ok over ${base}`,
      )
    }
  })

  console.log('')
  printSummary()
}

async function rpc(baseUrl, method, payload) {
  const response = await fetchWithTimeout(`${baseUrl}/api/${method}`, 15000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload,
    }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { parseError: text.slice(0, 200) }
  }
  return {
    httpStatus: response.status,
    body,
    result: body?.result ?? { ok: false, error: { code: 'internal', message: `HTTP ${response.status}` } },
  }
}

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    const elapsed = Date.now() - started
    checks.push({ name, ok: true, detail: `${elapsed}ms` })
    console.log(`PASS  ${name} (${elapsed}ms)`)
  } catch (error) {
    const elapsed = Date.now() - started
    checks.push({ name, ok: false, detail: String(error?.message ?? error) })
    console.log(`FAIL  ${name} (${elapsed}ms): ${String(error?.message ?? error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertHttp(response, expected) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${response.status}`)
  }
}

/**
 * Sends one raw HTTP POST with a caller-chosen Host header. Used only against
 * loopback to verify the browser-trust fence before Tailscale is involved.
 */
function rawHttpStatus(baseUrl, hostHeader) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl)
    const port = url.port || (url.protocol === 'https:' ? 443 : 80)
    const socket = net.connect({ host: url.hostname, port: Number(port), timeout: 5000 })
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'host.describe',
      payload: {},
    })
    let response = ''
    socket.on('connect', () => {
      socket.write([
        'POST /api/host.describe HTTP/1.1',
        `Host: ${hostHeader}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'))
    })
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => {
      const match = response.match(/^HTTP\/1\.[01] (\d{3})/)
      resolve(match ? Number(match[1]) : 0)
    })
    socket.on('timeout', () => socket.destroy())
    socket.on('error', reject)
  })
}

function wsUrl(baseUrl, path) {
  const url = new URL(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function wsUpgrade(baseUrl, path, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl(baseUrl, path))
    const timer = setTimeout(() => {
      socket.close()
      resolve(false)
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve(true)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve(false)
    }, { once: true })
  })
}

function wsFirstFrame(baseUrl, path, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl(baseUrl, path))
    const timer = setTimeout(() => {
      socket.close()
      resolve(undefined)
    }, timeoutMs)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      socket.close()
      try {
        resolve(JSON.parse(String(event.data)))
      } catch {
        resolve({ type: 'unparseable', data: String(event.data).slice(0, 200) })
      }
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    }, { once: true })
  })
}

function printSummary() {
  const failed = checks.filter(check => !check.ok)
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.log('')
    console.log('Failed checks:')
    for (const check of failed) {
      console.log(`- ${check.name}: ${check.detail}`)
    }
    process.exitCode = 1
  }
}

await main()
