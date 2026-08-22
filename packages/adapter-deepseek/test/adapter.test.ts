import { describe, expect, it } from 'vitest'
import type {
  DeepSeekHarnessAdapterOptions,
  WebSocketConstructor,
  WebSocketLike,
} from '../src/index.js'
import { DeepSeekHarnessAdapter, HarnessAdapterError } from '../src/index.js'

class FakeWebSocket implements WebSocketLike {
  readyState = 1
  private listeners = new Map<string, Array<(event: { type: string; data?: unknown }) => void>>()

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { type: string; data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {}

  emit(type: 'open' | 'message' | 'close' | 'error', data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, data })
  }
}

interface FakeWebSocketConstructor extends WebSocketConstructor {
  last?: FakeWebSocket
}

const FakeWebSocketCtor = class extends FakeWebSocket {
  static last?: FakeWebSocket

  constructor(url: string) {
    super()
    void url
    FakeWebSocketCtor.last = this
  }
} as FakeWebSocketConstructor

function adapterWith(overrides: Partial<DeepSeekHarnessAdapterOptions> = {}): DeepSeekHarnessAdapter {
  return new DeepSeekHarnessAdapter({
    baseUrl: 'https://harness.test',
    hostId: 'host_1',
    newId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
    ...overrides,
  })
}

describe('DeepSeekHarnessAdapter', () => {
  it('posts the upstream client-request envelope', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const adapter = adapterWith({
      fetch: (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: 'id-1',
          result: {
            ok: true,
            value: { version: '0.0.1', cwd: '/tmp', attachedSessions: 0 },
          },
        }), { status: 200 })
      }) as typeof fetch,
    })

    const host = await adapter.hostDescribe()
    expect(host.hostId).toBe('host_1')
    expect(requests[0]?.url).toBe('https://harness.test/api/host.describe')
    expect(requests[0]?.body).toMatchObject({
      type: 'client-request',
      method: 'host.describe',
      payload: {},
    })
  })

  it('throws a HarnessAdapterError for upstream RPC failures', async () => {
    const adapter = adapterWith({
      fetch: (async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'id-1',
        result: { ok: false, error: { code: 'bad-request', message: 'nope', details: {} } },
      }), { status: 200 })) as typeof fetch,
    })

    await expect(adapter.hostDescribe()).rejects.toBeInstanceOf(HarnessAdapterError)
  })

  it('maps the safe preset roster without exposing authoring fields', async () => {
    const adapter = adapterWith({
      fetch: (async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'id-1',
        result: {
          ok: true,
          value: {
            presets: [{
              id: 'standard',
              trust: 'system',
              isDefault: true,
              name: '标准',
              description: '完整编码能力',
            }],
            authorable: true,
            hasDocument: true,
          },
        },
      }), { status: 200 })) as typeof fetch,
    })

    await expect(adapter.agentPresetList()).resolves.toEqual([{
      id: 'standard',
      trust: 'system',
      isDefault: true,
      name: '标准',
      description: '完整编码能力',
    }])
  })

  it('preserves the workspace archive baseline for remote list filtering', async () => {
    const adapter = adapterWith({
      fetch: (async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'id-1',
        result: {
          ok: true,
          value: {
            items: [{
              workspaceId: 'ws_1',
              path: '/repo',
              title: 'repo',
              sessionIds: ['session_1'],
              createdAt: '2026-08-22T00:00:00.000Z',
              updatedAt: '2026-08-22T00:00:00.000Z',
            }],
            archivedSessionIds: ['session_archived'],
          },
        },
      }), { status: 200 })) as typeof fetch,
    })

    await expect(adapter.workspaceList()).resolves.toMatchObject({
      items: [{ workspaceId: 'ws_1', path: '/repo', title: 'repo' }],
      archivedSessionIds: ['session_archived'],
    })
  })

  it('forwards complete session model selections to the upstream RPC', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    const adapter = adapterWith({
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
        requests.push(request)
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: 'id-1',
          result: {
            ok: true,
            value: { selected: { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'max' } },
          },
        }), { status: 200 })
      }) as typeof fetch,
    })

    await adapter.sessionSelectModel({
      sessionId: 'session_1',
      provider: 'deepseek',
      model: 'v4-pro',
      reasoningEffort: 'max',
    })
    expect(requests[0]).toMatchObject({
      method: 'session.selectModel',
      payload: {
        sessionId: 'session_1',
        provider: 'deepseek',
        model: 'v4-pro',
        reasoningEffort: 'max',
      },
    })
  })

  it('streams server-request frames from mux WebSocket', async () => {
    const adapter = adapterWith({ WebSocket: FakeWebSocketCtor })
    const seen: string[] = []

    const stream = adapter.muxEvents()
    const next = stream.next()
    FakeWebSocketCtor.last?.emit('open')
    FakeWebSocketCtor.last?.emit('message', JSON.stringify({
      type: 'server-request',
      rpcId: 'rpc-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session_1', lastSeq: 7 },
    }))
    const item = await next
    seen.push(item.value?.method ?? '')
    FakeWebSocketCtor.last?.emit('close')

    expect(seen).toEqual(['session/subscribed'])
  })
})
