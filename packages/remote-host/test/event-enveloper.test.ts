import { describe, expect, it } from 'vitest'
import type { HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import { MonotonicSequence, toRemoteEnvelope } from '../src/event-enveloper.js'
import { loopbackPrincipal } from '../src/principal.js'

describe('remote host event normalization', () => {
  it('assigns host-monotonic sequences', () => {
    const sequence = new MonotonicSequence()
    expect(sequence.next()).toBe(0)
    expect(sequence.next()).toBe(1)
  })

  it('derives stable event ids for upstream session events', () => {
    const message: HarnessServerRequest = {
      type: 'server-request',
      rpcId: 'rpc_1',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session_1',
        event: { type: 'assistant/chunk', seq: 42, time: 1700000000000, data: { chunk: 'x' } },
      },
    }
    const first = toRemoteEnvelope('host_1', 'mux', message, 9)
    const second = toRemoteEnvelope('host_1', 'mux', message, 10)
    expect(first).toMatchObject({ protocolVersion: 1, hostId: 'host_1', sequence: 9, type: 'session/event' })
    expect(first.eventId).toBe(second.eventId)
    expect(second.sequence).toBe(10)
  })

  it('derives the same key for connection-local baseline frames with different rpc ids', () => {
    const message = (rpcId: string): HarnessServerRequest => ({
      type: 'server-request',
      rpcId,
      method: 'session/subscribed',
      payload: {
        type: 'session/subscribed',
        sessionId: 'session_1',
        lastSeq: 7,
      },
    })
    const first = toRemoteEnvelope('host_1', 'mux', message('rpc_a'), 1)
    const second = toRemoteEnvelope('host_1', 'mux', message('rpc_b'), 2)
    expect(first.eventId).toBe(second.eventId)
  })

  it('embeds the remote host epoch when provided', () => {
    const message: HarnessServerRequest = {
      type: 'server-request',
      rpcId: 'rpc_3',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session_1', lastSeq: 0 },
    }
    expect(toRemoteEnvelope('host_1', 'mux', message, 1, 'epoch_1')).toMatchObject({ epoch: 'epoch_1' })
  })

  it('preserves upstream tool views on live session events', () => {
    const message: HarnessServerRequest = {
      type: 'server-request',
      rpcId: 'rpc_2',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session_1',
        event: { type: 'tool/call', seq: 43, time: 1700000000001, data: { name: 'bash' } },
        view: { for: 'call', view: { card: 'terminal', title: 'ls' } },
      },
    }
    const envelope = toRemoteEnvelope('host_1', 'mux', message, 11)
    expect(envelope.payload).toMatchObject({
      view: { for: 'call', view: { card: 'terminal', title: 'ls' } },
    })
  })

  it('echoes upstream approval rpcId in the remote payload', () => {
    const message: HarnessServerRequest = {
      type: 'server-request',
      rpcId: 'approval-rpc',
      method: 'approval/requested',
      payload: {
        type: 'approval/requested',
        sessionId: 'session_1',
        approvalId: 'approval_1',
        toolName: 'bash',
        reason: 'test',
      },
    }
    const envelope = toRemoteEnvelope('host_1', 'mux', message, 3)
    expect(envelope).toMatchObject({
      type: 'approval/requested',
      payload: {
        sessionId: 'session_1',
        rpcId: 'approval-rpc',
        approvalId: 'approval_1',
      },
    })
  })

  it('maps the A1 loopback principal', () => {
    const principal = loopbackPrincipal({ userId: 'user_1', deviceId: 'tailscale-serve', hostId: 'host_1' })
    expect(principal).toMatchObject({ userId: 'user_1', roles: ['owner'] })
  })
})
