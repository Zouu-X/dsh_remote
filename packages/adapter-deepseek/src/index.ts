import type {
  ApprovalDecision,
  HostDescriptor,
  PromptInput,
  QuestionDecision,
  SessionCreateInput,
  SessionEventView,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionSummary,
  WorkspaceCreateInput,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import type { EventId, HostId } from '@dsh-remote/protocol'

/**
 * The only package that knows the DeepSeek Harness upstream wire contract.
 *
 * This package consumes the HTTP RPC and the two downlink WebSocket endpoints
 * exposed by DeepSeek Harness. The upstream project is a developer preview,
 * so every call and every frame type lives behind this adapter.
 */

export interface HarnessRpcError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export type HarnessRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessRpcError }

export interface HarnessServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

interface HarnessClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface HarnessClientResponse {
  type: 'client-response'
  rpcId: string
  result: { ok: true; value: unknown }
}

interface HarnessServerResponse<T> {
  type: 'server-response'
  rpcId: string
  result: HarnessRpcResult<T>
}

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

export interface DeepSeekHarnessAdapterOptions {
  baseUrl: string
  /** Stable id for the Mac host; also used to derive deterministic event ids. */
  hostId: HostId
  fetch?: typeof fetch
  WebSocket?: WebSocketConstructor
  newId?: () => string
  timeoutMs?: number
}

export class HarnessAdapterError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'protocol' | 'rpc',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HarnessAdapterError'
  }
}

export class DeepSeekHarnessAdapter {
  private readonly baseUrl: string
  private readonly hostId: HostId
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: WebSocketConstructor
  private readonly newId: () => string
  private readonly timeoutMs: number
  private readonly sockets = new Set<WebSocketLike>()

  constructor(options: DeepSeekHarnessAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.hostId = options.hostId
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.WebSocketImpl = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async hostDescribe(): Promise<HostDescriptor> {
    const value = await this.call<{
      version: string
      cwd: string
      provider?: string
      model?: string
      attachedSessions: number
    }>('host.describe', {})

    return {
      hostId: this.hostId,
      version: value.version,
      cwd: value.cwd,
      ...(value.provider !== undefined && { provider: value.provider }),
      ...(value.model !== undefined && { model: value.model }),
      attachedSessions: value.attachedSessions,
      principalUserId: '',
      principalDeviceId: '',
    }
  }

  async workspaceList(): Promise<WorkspaceSummary[]> {
    const value = await this.call<{
      items: Array<{
        workspaceId: string
        path: string
        title: string
        sessionIds: string[]
        createdAt: string
        updatedAt: string
      }>
    }>('workspace.list', {})

    return value.items.map(workspace => ({
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }))
  }

  async workspaceCreate(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }> {
    const value = await this.call<{
      workspace: {
        workspaceId: string
        path: string
        title: string
        sessionIds: string[]
        createdAt: string
        updatedAt: string
      }
      created: boolean
    }>('workspace.create', { path: input.path })

    return {
      created: value.created,
      workspace: {
        workspaceId: value.workspace.workspaceId,
        path: value.workspace.path,
        title: value.workspace.title,
        sessionIds: value.workspace.sessionIds,
        createdAt: value.workspace.createdAt,
        updatedAt: value.workspace.updatedAt,
      },
    }
  }

  async sessionList(): Promise<SessionSummary[]> {
    const [sessions, workspaces] = await Promise.all([
      this.call<{
        items: Array<{
          sessionId: string
          updatedAt: number
          running: boolean
          blank: boolean
          cwd?: string
          agentPreset?: string
          projections?: {
            asOfSeq: number
            values: Record<string, unknown>
          }
        }>
      }>('session.list', {}),
      this.call<{ items: Array<{ workspaceId: string; sessionIds: string[] }> }>('workspace.list', {}),
    ])

    const workspaceBySession = new Map<string, string>()
    for (const workspace of workspaces.items) {
      for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace.workspaceId)
    }

    return sessions.items.map(item => {
      const title = item.projections?.values.title
      const workspaceId = workspaceBySession.get(item.sessionId)
      return {
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
        lastSeq: item.projections?.asOfSeq ?? -1,
        ...(workspaceId !== undefined && { workspaceId }),
        ...(typeof title === 'string' && { title }),
        ...(item.cwd !== undefined && { cwd: item.cwd }),
        ...(item.agentPreset !== undefined && { agentPreset: item.agentPreset }),
      }
    })
  }

  async sessionSearch(query: string): Promise<{ items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean }> {
    const value = await this.call<{
      items: Array<{ sessionId: string; snippet: string }>
      hasMore: boolean
    }>('session.search', { query })
    return {
      items: value.items.map(item => ({ sessionId: item.sessionId, snippet: item.snippet })),
      hasMore: value.hasMore,
    }
  }

  async sessionCreate(input: SessionCreateInput): Promise<string> {
    const value = await this.call<{ sessionId: string }>('session.create', {
      ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      ...(input.agentPreset !== undefined && { agentPreset: input.agentPreset }),
    })
    return value.sessionId
  }

  async sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage> {
    const { sessionId, ...page } = query
    const value = await this.call<{
      events: Array<{
        event: {
          type: string
          seq: number
          time: number
          data: unknown
        }
        view?: unknown
      }>
      hasMore: boolean
    }>('session.history', {
      sessionId,
      ...(page.beforeSeq !== undefined && { beforeSeq: page.beforeSeq }),
      ...(page.maxMessages !== undefined && { maxMessages: page.maxMessages }),
    })

    const events: SessionEventView[] = value.events.map(entry => ({
      eventId: this.eventId(sessionId, entry.event.seq),
      sessionId,
      sequence: entry.event.seq,
      type: entry.event.type,
      payload: entry.event.data,
      timestamp: new Date(entry.event.time).toISOString(),
      ...(entry.view !== undefined && { view: entry.view }),
    }))

    return { sessionId, events, hasMore: value.hasMore }
  }

  async sessionPrompt(input: PromptInput): Promise<void> {
    await this.call<{ accepted: true }>('session.prompt', {
      sessionId: input.sessionId,
      mode: input.mode,
      content: [{ type: 'text', text: input.text }],
      clientTimeZone: 'Asia/Shanghai',
    })
  }

  async approvalRespond(rpcId: string, decision: ApprovalDecision): Promise<{ accepted: boolean }> {
    const value = await this.respond(rpcId, {
      sessionId: decision.sessionId,
      approvalId: decision.approvalId,
      outcome: decision.outcome,
    })
    return { accepted: value.accepted }
  }

  async questionRespond(rpcId: string, decision: QuestionDecision): Promise<{ accepted: boolean }> {
    const value = await this.respond(rpcId, {
      sessionId: decision.sessionId,
      answer: decision.answer,
    })
    return { accepted: value.accepted }
  }

  /** Yields upstream mux server-requests until the socket closes or aborts. */
  async *muxEvents(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    yield * this.websocketEvents('/api/events.mux', signal)
  }

  /** Yields upstream host server-requests until the socket closes or aborts. */
  async *hostEvents(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    yield * this.websocketEvents('/api/events.host', signal)
  }

  close(): void {
    for (const socket of this.sockets) socket.close()
    this.sockets.clear()
  }

  private eventId(sessionId: string, sequence: number): EventId {
    return `${this.hostId}:${sessionId}:${sequence}` as EventId
  }

  private async call<T>(method: string, payload: unknown): Promise<T> {
    const result = await this.callRaw<T>(method, payload)
    if (!result.ok) {
      throw new HarnessAdapterError(
        `upstream RPC ${method} failed: ${result.error.message}`,
        'rpc',
      )
    }
    return result.value
  }

  private async callRaw<T>(method: string, payload: unknown): Promise<HarnessRpcResult<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`upstream RPC ${method} timed out`)), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: this.newId(),
          method,
          payload,
        } satisfies HarnessClientRequest),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new HarnessAdapterError(
          `upstream HTTP ${response.status} for ${method}: ${body.slice(0, 200)}`,
          'http',
          response.status,
        )
      }

      const body = (await response.json()) as HarnessServerResponse<T>
      if (body.type !== 'server-response') {
        throw new HarnessAdapterError(`unexpected upstream response for ${method}`, 'protocol')
      }
      return body.result
    } finally {
      clearTimeout(timer)
    }
  }

  private async respond(rpcId: string, value: unknown): Promise<{ accepted: boolean }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value },
      } satisfies HarnessClientResponse),
    })

    if (!response.ok) {
      throw new HarnessAdapterError(`upstream HTTP ${response.status} for /api/respond`, 'http', response.status)
    }

    const body = (await response.json()) as { accepted: boolean } | { accepted: false; reason: string }
    return { accepted: body.accepted === true }
  }

  private async *websocketEvents(path: string, signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const socket = new this.WebSocketImpl(url.toString())
    this.sockets.add(socket)

    const messages: HarnessServerRequest[] = []
    let wake: (() => void) | undefined
    let closed = false

    const closeListener = () => {
      closed = true
      wake?.()
    }

    socket.addEventListener('open', () => wake?.())
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data ?? '')) as { type?: string }
        if (message.type === 'server-request') {
          messages.push(message as HarnessServerRequest)
          wake?.()
        }
      } catch {
        // Ignore malformed upstream frames; the remote layer treats socket
        // liveness and session.history recovery as the fallback.
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
        const timer = setTimeout(() => reject(new HarnessAdapterError(`WebSocket ${path} open timed out`, 'protocol')), this.timeoutMs)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new HarnessAdapterError(`WebSocket ${path} failed to open`, 'protocol'))
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
}
