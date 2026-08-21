import type {
  ApprovalDecision,
  HostDescriptor,
  PromptInput,
  QuestionDecision,
  RemoteApiMap,
  RemoteMethod,
  SessionCreateInput,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionSearchItem,
  SessionSummary,
  WorkspaceCreateInput,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import {
  PROTOCOL_VERSION,
  isRemoteEventEnvelope,
  isRemoteRpcResponse,
  newRequestId,
  type RemoteEventEnvelope,
  type RemoteHostHealth,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
} from '@dsh-remote/protocol'

export * from './sequence-tracker.js'

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WebSocketEventLike) => void): void
  close(): void
}

export interface WebSocketEventLike {
  type: string
  data?: unknown
}

export type WebSocketConstructor = new (url: string) => WebSocketLike

export interface AgentHostTransport {
  readonly baseUrl: string
  health(): Promise<RemoteHostHealth>
  hostDescribe(): Promise<HostDescriptor>
  listWorkspaces(): Promise<{ items: WorkspaceSummary[] }>
  createWorkspace(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }>
  listSessions(): Promise<{ items: SessionSummary[] }>
  searchSessions(query: string): Promise<{ items: SessionSearchItem[]; hasMore: boolean }>
  createSession(input: SessionCreateInput, idempotencyKey?: string): Promise<string>
  sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage>
  prompt(input: PromptInput, idempotencyKey?: string): Promise<void>
  approvalRespond(decision: ApprovalDecision): Promise<{ accepted: boolean }>
  questionRespond(decision: QuestionDecision): Promise<{ accepted: boolean }>
  events(kind?: 'mux' | 'host', signal?: AbortSignal): AsyncGenerator<RemoteEventEnvelope>
  close(): void
}

export interface DirectTailnetTransportOptions {
  baseUrl: string
  fetch?: typeof fetch
  WebSocket?: WebSocketConstructor
  timeoutMs?: number
}

export class RemoteTransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'protocol' | 'rpc',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RemoteTransportError'
  }
}

/**
 * A-transport: talks to the loopback Remote Host Adapter through Tailscale
 * Serve. B will implement the same AgentHostTransport over the Relay.
 */
export class DirectTailnetTransport implements AgentHostTransport {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: WebSocketConstructor
  private readonly timeoutMs: number
  private readonly sockets = new Set<WebSocketLike>()

  constructor(options: DirectTailnetTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.WebSocketImpl = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor)
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async health(): Promise<RemoteHostHealth> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/health`)
    if (!response.ok) throw new RemoteTransportError(`health HTTP ${response.status}`, 'http', response.status)
    return response.json() as Promise<RemoteHostHealth>
  }

  hostDescribe(): Promise<HostDescriptor> {
    return this.rpc('host.describe', {})
  }

  listWorkspaces(): Promise<{ items: WorkspaceSummary[] }> {
    return this.rpc('workspace.list', {})
  }

  createWorkspace(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }> {
    return this.rpc('workspace.create', input)
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.rpc('session.list', {})
  }

  searchSessions(query: string): Promise<{ items: SessionSearchItem[]; hasMore: boolean }> {
    return this.rpc('session.search', { query })
  }

  async createSession(input: SessionCreateInput, idempotencyKey?: string): Promise<string> {
    const value = await this.rpc('session.create', input, idempotencyKey)
    return value.sessionId
  }

  sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.rpc('session.history', query)
  }

  async prompt(input: PromptInput, idempotencyKey?: string): Promise<void> {
    await this.rpc('session.prompt', input, idempotencyKey)
  }

  async approvalRespond(decision: ApprovalDecision): Promise<{ accepted: boolean }> {
    return this.rpc(
      'approval.respond',
      decision,
      `approval:${decision.sessionId}:${decision.approvalId}:${decision.rpcId}`,
    )
  }

  async questionRespond(decision: QuestionDecision): Promise<{ accepted: boolean }> {
    return this.rpc(
      'question.respond',
      decision,
      `question:${decision.sessionId}:${decision.rpcId}`,
    )
  }

  async *events(kind: 'mux' | 'host' = 'mux', signal?: AbortSignal): AsyncGenerator<RemoteEventEnvelope> {
    const path = kind === 'mux' ? '/api/remote/events.mux' : '/api/remote/events.host'
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const socket = new this.WebSocketImpl(url.toString())
    this.sockets.add(socket)

    const messages: RemoteEventEnvelope[] = []
    let wake: (() => void) | undefined
    let closed = false

    const closeListener = () => {
      closed = true
      wake?.()
    }
    socket.addEventListener('open', () => wake?.())
    socket.addEventListener('message', event => {
      try {
        const value = JSON.parse(String(event.data ?? '')) as unknown
        if (isRemoteEventEnvelope(value)) {
          messages.push(value)
          wake?.()
        }
      } catch {
        // Ignore malformed frames; the transport remains re-openable.
      }
    })
    socket.addEventListener('close', closeListener)
    socket.addEventListener('error', closeListener)

    const onAbort = () => {
      closed = true
      socket.close()
      wake?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RemoteTransportError(`WebSocket ${path} open timed out`, 'protocol')), this.timeoutMs)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new RemoteTransportError(`WebSocket ${path} failed to open`, 'protocol'))
        })
      })

      while (true) {
        if (messages.length > 0) {
          yield messages.shift()!
        } else if (closed) {
          return
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      socket.close()
      this.sockets.delete(socket)
    }
  }

  close(): void {
    for (const socket of this.sockets) socket.close()
    this.sockets.clear()
  }

  private async rpc<M extends RemoteMethod>(
    method: M,
    payload: RemoteApiMap[M]['payload'],
    idempotencyKey?: string,
  ): Promise<RemoteApiMap[M]['result']> {
    const request: RemoteRpcRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: newRequestId(),
      method,
      payload,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    }
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/remote/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      throw new RemoteTransportError(`remote HTTP ${response.status} for ${method}`, 'http', response.status)
    }

    const body = (await response.json()) as unknown
    if (!isRemoteRpcResponse(body)) {
      throw new RemoteTransportError(`invalid remote response for ${method}`, 'protocol')
    }
    if (body.requestId !== request.requestId || body.method !== method) {
      throw new RemoteTransportError(`response correlation failed for ${method}`, 'protocol')
    }
    if (!body.result.ok) {
      throw new RemoteTransportError(`remote RPC ${method}: ${body.result.error.message}`, 'rpc')
    }
    return body.result.value as RemoteApiMap[M]['result']
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('remote request timed out')), this.timeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
