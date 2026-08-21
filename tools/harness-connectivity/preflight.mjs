#!/usr/bin/env node
/**
 * Preflight check: reports whether the Mac is ready for the Tailscale Serve
 * path without printing any API key, token, or private-key content.
 *
 * Usage: node tools/harness-connectivity/preflight.mjs
 */

import { execFileSync } from 'node:child_process'

const results = []

function section(title) {
  console.log(`\n== ${title} ==`)
}

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function run(bin, args = [], options = {}) {
  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: options.timeout ?? 15000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    })
    return { ok: true, output: String(output).trim() }
  } catch (error) {
    return {
      ok: false,
      output: String(error?.stdout ?? '').trim(),
      error: String(error?.stderr ?? error?.message ?? error).trim(),
    }
  }
}

function redactCommand(command) {
  return String(command)
    .replace(/(--(?:api-?key|token|secret)[= ][^ ]+)/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_KEY]')
}

section('Node and Harness')

const node = run('node', ['--version'])
record('node --version', node.ok, node.output)

const dsh = run('dsh', ['--version'])
record('dsh --version', dsh.ok, dsh.output)

const lsof = run('lsof', ['-nP', '-iTCP:3080', '-sTCP:LISTEN'])
if (lsof.ok && /3080/.test(lsof.output)) {
  const line = lsof.output.split('\n').find(candidate => candidate.includes('LISTEN')) ?? lsof.output.split('\n')[1] ?? ''
  const pid = line.trim().split(/\s+/)[1]
  record('Harness listener on TCP 3080', true, pid ? `pid ${pid}` : 'found')

  if (pid) {
    const ps = run('ps', ['-ww', '-p', pid, '-o', 'command='])
    if (ps.ok && ps.output) {
      const command = redactCommand(ps.output)
      record('Harness command line', true, command)
      if (/--trusted-host/.test(command)) {
        record('Harness has --trusted-host', true)
      } else {
        record('Harness has --trusted-host', false, 'remote access will be rejected until restarted with the real Tailnet hostname')
      }
    } else {
      record('Harness command line', false, ps.error || 'ps unavailable')
    }
  }
} else {
  record('Harness listener on TCP 3080', false, 'no listener found; start `npx @deepseek-ai/dsh web`')
}

section('Tailscale')

const tailscale = run('tailscale', ['version'])
record('tailscale CLI', tailscale.ok, tailscale.output.split('\n')[0] ?? '')

if (tailscale.ok) {
  const status = run('tailscale', ['status'])
  record('tailscale status', status.ok, status.ok ? status.output.split('\n')[0] : status.error)

  const serve = run('tailscale', ['serve', 'status'])
  record('tailscale serve status', serve.ok, serve.ok ? serve.output.split('\n')[0] : serve.error)
} else {
  console.log('Tailscale 未安装。需要人工安装并登录：')
  console.log('  brew install --cask tailscale')
  console.log('  或从 App Store 安装 Tailscale')
}

section('Loopback HTTP')

const http = run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'http://127.0.0.1:3080/'])
record('GET http://127.0.0.1:3080/', http.ok && http.output === '200', `HTTP ${http.output}`)

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} preflight checks passed`)
if (failed.length > 0) {
  console.log('Blockers:')
  for (const result of failed) console.log(`- ${result.name}: ${result.detail}`)
  process.exitCode = 1
}
