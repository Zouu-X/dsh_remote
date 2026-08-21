#!/usr/bin/env node
/**
 * Task runner: sends one prompt over the Tailscale Serve authority,
 * consumes /api/events.mux for that session, optionally answers questions
 * and approvals, optionally steers mid-run, and then reads session.history.
 *
 * Read the generated output as a wire-level trace; it does not print
 * API keys or credential contents. Keep prompt text limited to the scratch
 * workspace used for connectivity validation.
 *
 * Usage:
 *   node tools/harness-connectivity/task.mjs \
 *     --session <session-id> \
 *     --prompt "<prompt>" \
 *     [--auto-approval allowed-once|rejected] \
 *     [--answer-first] \
 *     [--steer-after 5000] [--steer "<text>"] \
 *     [--reconnect-after 8000] \
 *     [--base http://127.0.0.1:3080]
 */

import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const options = {
  base: 'http://127.0.0.1:3080',
  session: '',
  prompt: '',
  autoApproval: '',
  answerFirst: false,
  steerAfter: 0,
  steer: '',
  reconnectAfter: 0,
  timeout: 300_000,
}

for (let i = 0; i < args.length; i += 1) {
  const key = args[i]
  const value = args[i + 1]
  let consumesValue = false
  if (key === '--base') { options.base = requireValue(value, key); consumesValue = true }
  else if (key === '--session') { options.session = requireValue(value, key); consumesValue = true }
  else if (key === '--prompt') { options.prompt = requireValue(value, key); consumesValue = true }
  else if (key === '--auto-approval') { options.autoApproval = requireValue(value, key); consumesValue = true }
  else if (key === '--answer-first') options.answerFirst = true
  else if (key === '--steer-after') { options.steerAfter = Number(requireValue(value, key)); consumesValue = true }
  else if (key === '--steer') { options.steer = requireValue(value, key); consumesValue = true }
  else if (key === '--reconnect-after') { options.reconnectAfter = Number(requireValue(value, key)); consumesValue = true }
  else if (key === '--timeout') { options.timeout = Number(requireValue(value, key)); consumesValue = true }
  else if (key === '--help' || key === '-h') { console.log(helpText()); process.exit(0) }
  else failUsage(`unknown argument: ${key}`)
  if (consumesValue) i += 1
}

if (!options.session) failUsage('--session <session-id> is required')
if (!options.prompt) failUsage('--prompt <text> is required')
if (options.autoApproval && !['allowed-once', 'rejected'].includes(options.autoApproval)) {
  failUsage('--auto-approval must be allowed-once or rejected')
}

const seenEvents = new Map()
const seenFrames = new Map()
let mux = null
let closedByReconnect = false
let autoReconnectTimer = null
let autoReconnectAttempts = 0
let promptAccepted = false
let steerSent = false
let completed = false
let failure = null

function requireValue(value, key) {
  if (!value) failUsage(`${key} requires a value`)
  return value
}

function failUsage(message) {
  console.error(`error: ${message}\n${helpText()}`)
  process.exit(2)
}

function helpText() {
  return `Usage: node tools/harness-connectivity/task.mjs --session <session-id> --prompt <text> [options]

Options:
  --base <url>                 Default http://127.0.0.1:3080
  --auto-approval <outcome>    Answer approval/requested frames automatically
  --answer-first               Answer question/requested with each first option
  --steer-after <ms>           Send mode=steer after this many milliseconds
  --steer <text>               Steering text
  --reconnect-after <ms>       Drop and reopen the mux socket once
  --timeout <ms>               Total timeout
`
}

async function main() {
  console.log(`Task session=${options.session}`)
  console.log(`base=${options.base}`)
  console.log(`prompt=${options.prompt}`)
  console.log('')

  mux = openMux()

  const result = await rpc('session.prompt', {
    sessionId: options.session,
    mode: 'queue',
    content: [{ type: 'text', text: options.prompt }],
    clientTimeZone: 'Asia/Shanghai',
  })
  console.log(`session.prompt -> ${JSON.stringify(result)}`)
  if (!result.result?.ok) {
    console.error(`prompt rejected: ${JSON.stringify(result.result)}`)
    process.exit(1)
  }
  promptAccepted = true

  if (options.steerAfter > 0) setTimeout(sendSteer, options.steerAfter)
  if (options.reconnectAfter > 0) setTimeout(reconnect, options.reconnectAfter)

  const deadline = Date.now() + options.timeout
  while (Date.now() < deadline) {
    await sleep(2000)
    const status = await rpc('session.list', {})
    const row = status.result?.value?.items?.find(item => item.sessionId === options.session)
    if (!row) {
      failure = new Error('session disappeared from session.list')
      break
    }
    if (!row.blank && promptAccepted && !row.running) {
      completed = true
      break
    }
  }

  if (mux) mux.close()

  console.log('')
  console.log(`event types observed (${seenEvents.size}):`)
  for (const [type, value] of [...seenEvents.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${type} x${value.count} (lastSeq=${value.lastSeq})`)
  }
  console.log('')
  console.log(`control frames observed (${seenFrames.size}):`)
  for (const [type, count] of [...seenFrames.entries()].sort()) {
    console.log(`  ${type} x${count}`)
  }
  console.log('')

  if (failure) {
    console.error(`FAIL ${failure.message}`)
    process.exitCode = 1
    return
  }
  if (!completed) {
    console.error(`FAIL task did not finish within ${options.timeout}ms`)
    process.exitCode = 1
    return
  }
  if (seenEvents.size === 0) {
    console.error('FAIL no session events arrived on the mux stream')
    process.exitCode = 1
    return
  }
  console.log('PASS prompt completed and event stream delivered session events')
}

function openMux() {
  const socket = new WebSocket(wsUrl(options.base, '/api/events.mux'))
  socket.addEventListener('open', () => {
    console.log('mux open')
    autoReconnectAttempts = 0
    if (autoReconnectTimer) {
      clearTimeout(autoReconnectTimer)
      autoReconnectTimer = null
    }
  })
  socket.addEventListener('message', event => onFrame(JSON.parse(String(event.data))))
  socket.addEventListener('close', () => {
    console.log(`mux closed${closedByReconnect ? ' (planned reconnect)' : ''}`)
    scheduleAutoReconnect('close')
  })
  socket.addEventListener('error', () => {
    scheduleAutoReconnect('error')
  })
  return socket
}

function scheduleAutoReconnect(reason) {
  if (closedByReconnect || completed || autoReconnectTimer) return
  if (autoReconnectAttempts >= 10) {
    failure = failure ?? new Error(`mux ${reason}: too many reconnect attempts`)
    return
  }
  autoReconnectAttempts += 1
  console.log(`       mux ${reason}: auto-reconnect in 1s (attempt ${autoReconnectAttempts}/10)`)
  autoReconnectTimer = setTimeout(() => {
    autoReconnectTimer = null
    mux = openMux()
  }, 1000)
}

function onFrame(message) {
  if (message.type !== 'server-request') return
  const frame = message.payload
  if (!frame || frame.sessionId !== options.session) return

  if (frame.type === 'session/event') {
    const event = frame.event
    const prior = seenEvents.get(event.type) ?? { count: 0, lastSeq: -1 }
    seenEvents.set(event.type, { count: prior.count + 1, lastSeq: event.seq })
    const count = prior.count + 1
    if (event.type === 'assistant/chunk') {
      if (count % 50 === 0) console.log(`EVENT  seq=${String(event.seq).padStart(5)} type=${event.type} count=${count}`)
      return
    }
    let detail = ''
    if (event.type === 'tool/call') {
      const args = typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments ?? {})
      detail = ` name=${event.data?.name ?? ''} args=${truncate(args, 300)}`
    } else if (event.type === 'tool/result') {
      const view = frame.view?.view
      if (view?.card === 'terminal') {
        detail = ` terminal=${JSON.stringify(view.output ?? '')} exit=${view.exitCode ?? ''}`
      } else if (view?.card === 'diff') {
        detail = ` diff=${JSON.stringify((view.diffs ?? []).map(diff => diff.path))}`
      } else {
        detail = ` card=${view?.card ?? 'none'}`
      }
    } else if (event.type === 'assistant/message') {
      detail = ` text=${truncate(messageText(event.data), 500)}`
    }
    console.log(`EVENT  seq=${String(event.seq).padStart(5)} type=${event.type}${detail}`)
  } else if (frame.type === 'approval/requested') {
    seenFrames.set('approval/requested', (seenFrames.get('approval/requested') ?? 0) + 1)
    console.log(`FRAME  approval/requested approvalId=${frame.approvalId} tool=${frame.toolName} reason=${frame.reason ?? ''}`)
    if (options.autoApproval) answerApproval(message, frame)
    else console.log('       no --auto-approval; request left pending')
  } else if (frame.type === 'question/requested') {
    seenFrames.set('question/requested', (seenFrames.get('question/requested') ?? 0) + 1)
    console.log(`FRAME  question/requested rpcId=${message.rpcId} questions=${JSON.stringify(frame.questions)}`)
    if (options.answerFirst) answerQuestion(message, frame)
    else console.log('       no --answer-first; question left pending')
  } else if (frame.type === 'approval/resolved') {
    console.log(`FRAME  approval/resolved approvalId=${frame.approvalId} outcome=${frame.outcome}`)
  } else if (frame.type === 'question/resolved') {
    console.log(`FRAME  question/resolved outcome=${frame.outcome}`)
  } else {
    seenFrames.set(frame.type, (seenFrames.get(frame.type) ?? 0) + 1)
    console.log(`FRAME  ${frame.type}`)
  }
}

async function answerApproval(message, frame) {
  const value = {
    sessionId: options.session,
    approvalId: frame.approvalId,
    outcome: options.autoApproval,
  }
  const receipt = await respond(message.rpcId, value)
  console.log(`       respond approval=${options.autoApproval} -> ${JSON.stringify(receipt)}`)
}

async function answerQuestion(message, frame) {
  const answers = frame.questions.map(question => ({
    id: question.id,
    selected: question.options?.[0] ? [question.options[0].label] : [],
  }))
  const receipt = await respond(message.rpcId, {
    sessionId: options.session,
    answer: { answers },
  })
  console.log(`       respond question first-options -> ${JSON.stringify(receipt)}`)
}

function sendSteer() {
  if (steerSent || completed) return
  steerSent = true
  console.log(`       steer attempt: ${options.steer}`)
  rpc('session.prompt', {
    sessionId: options.session,
    mode: 'steer',
    content: [{ type: 'text', text: options.steer }],
    clientTimeZone: 'Asia/Shanghai',
  }).then(result => {
    console.log(`       session.prompt steer -> ${JSON.stringify(result)}`)
  })
}

function reconnect() {
  if (closedByReconnect || completed) return
  closedByReconnect = true
  console.log('       reconnect: closing mux socket')
  mux?.close()
  setTimeout(() => {
    closedByReconnect = false
    mux = openMux()
  }, 500)
}

async function rpc(method, payload) {
  const response = await fetch(`${options.base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload,
    }),
  })
  return response.json()
}

async function respond(rpcId, value) {
  const response = await fetch(`${options.base}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }),
  })
  return response.json()
}

function wsUrl(baseUrl, path) {
  const url = new URL(path, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function messageText(eventData) {
  const content = eventData?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text')
    .map(block => block.text ?? '')
    .join(' ')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

await main()
