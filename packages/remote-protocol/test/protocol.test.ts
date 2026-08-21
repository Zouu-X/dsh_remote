import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  isRemoteEventEnvelope,
  isRemoteRpcRequest,
  isRemoteRpcResponse,
  newEventId,
  newRequestId,
} from '../src/index.js'

describe('remote protocol v1', () => {
  it('accepts a valid event envelope', () => {
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'host_1',
      stream: 'mux',
      epoch: 'epoch_1',
      sessionId: 'session_1',
      eventId: newEventId(),
      sequence: 7,
      type: 'session/event',
      payload: { ok: true },
      timestamp: new Date().toISOString(),
    }
    expect(isRemoteEventEnvelope(envelope)).toBe(true)
  })

  it('rejects envelopes from another protocol version', () => {
    expect(isRemoteEventEnvelope({
      protocolVersion: 2,
      hostId: 'host_1',
      stream: 'host',
      eventId: newEventId(),
      sequence: 1,
      type: 'session/event',
      payload: {},
      timestamp: new Date().toISOString(),
    })).toBe(false)
  })

  it('accepts optional string epochs but rejects non-string epochs', () => {
    expect(isRemoteEventEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'host_1',
      stream: 'mux',
      eventId: newEventId(),
      sequence: 1,
      type: 'session/event',
      payload: {},
      timestamp: new Date().toISOString(),
    })).toBe(true)
    expect(isRemoteEventEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'host_1',
      stream: 'mux',
      epoch: 7,
      eventId: newEventId(),
      sequence: 1,
      type: 'session/event',
      payload: {},
      timestamp: new Date().toISOString(),
    })).toBe(false)
  })

  it('validates rpc responses', () => {
    expect(isRemoteRpcResponse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: newRequestId(),
      method: 'session.list',
      result: { ok: true, value: {} },
    })).toBe(true)
  })

  it('accepts rpc requests with idempotency keys', () => {
    expect(isRemoteRpcRequest({
      protocolVersion: PROTOCOL_VERSION,
      requestId: newRequestId(),
      method: 'session.prompt',
      payload: {},
      idempotencyKey: 'prompt_1',
    })).toBe(true)
    expect(isRemoteRpcRequest({
      protocolVersion: PROTOCOL_VERSION,
      requestId: newRequestId(),
      method: 'session.prompt',
      payload: {},
      idempotencyKey: 7,
    })).toBe(false)
  })
})
