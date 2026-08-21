import { describe, expect, it } from 'vitest'
import { buildReviewTimeline, unwrapToolView } from '../src/index.js'
import type { SessionEventView } from '../src/index.js'

function event(seq: number, type: string, payload: unknown, view?: unknown): SessionEventView {
  return {
    eventId: `event_${seq}`,
    sessionId: 'session_1',
    sequence: seq,
    type,
    payload,
    timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
    ...(view === undefined ? {} : { view }),
  }
}

describe('review timeline', () => {
  it('folds assistant chunks into one partial message when no message exists yet', () => {
    const nodes = buildReviewTimeline([
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } }),
      event(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '一想' } }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '答案' } }),
    ])
    const message = nodes.find(node => node.kind === 'message')
    expect(message?.kind).toBe('message')
    if (message?.kind === 'message') {
      expect(message.partial).toBe(true)
      expect(message.reasoning).toBe('想一想')
      expect(message.text).toBe('答案')
    }
    expect(nodes.filter(node => node.kind === 'message')).toHaveLength(1)
  })

  it('prefers the complete assistant message over its chunk stream', () => {
    const nodes = buildReviewTimeline([
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '旧' } }),
      event(1, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完整答案' }] } }),
    ])
    const messages = nodes.filter(node => node.kind === 'message')
    expect(messages).toHaveLength(1)
    if (messages[0]?.kind === 'message') {
      expect(messages[0].text).toBe('完整答案')
      expect(messages[0].partial).toBeUndefined()
    }
  })

  it('pairs tool call and result and extracts fallback result text', () => {
    const nodes = buildReviewTimeline([
      event(0, 'tool/call', { callId: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' }, { for: 'call', view: { card: 'terminal', title: 'pwd' } }),
      event(1, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: '/tmp' }] }] } }),
    ])
    expect(nodes).toHaveLength(1)
    const tool = nodes[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.name).toBe('bash')
      expect(tool.title).toBe('pwd')
      expect(tool.callView).toEqual({ card: 'terminal', title: 'pwd' })
      expect(tool.resultText).toBe('/tmp')
      expect(tool.resultIsError).toBeUndefined()
    }
  })

  it('folds permission and sandbox events into status markers', () => {
    const nodes = buildReviewTimeline([
      event(0, 'permission/preset', { preset: 'workspace-write' }),
      event(1, 'sandbox/mode', { mode: 'workspace-write' }),
      event(2, 'user/message', { message: { content: [{ type: 'text', text: 'hello' }] } }),
    ])
    expect(nodes.filter(node => node.kind === 'status')).toHaveLength(2)
    expect(nodes.filter(node => node.kind === 'message')).toHaveLength(1)
  })

  it('unwraps the upstream for/call view envelope', () => {
    expect(unwrapToolView({ for: 'call', view: { card: 'terminal', title: 'ls' } }))
      .toEqual({ card: 'terminal', title: 'ls' })
    expect(unwrapToolView(undefined)).toBeUndefined()
  })
})
