import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { extname, join, normalize } from 'node:path'
import type { Duplex } from 'node:stream'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import {
  isRemoteMethod,
  REMOTE_METHOD_CAPABILITIES,
  authorizeRemoteMethod,
} from '@dsh-remote/auth-core'
import type {
  AgentPresetSelectInput,
  ApprovalDecision,
  HostDescriptor,
  PromptInput,
  QuestionDecision,
  SessionCreateInput,
  SessionHistoryQuery,
  SessionModelSelectInput,
  WorkspaceCreateInput,
} from '@dsh-remote/domain'
import {
  PROTOCOL_VERSION,
  isRemoteRpcRequest,
  type RemoteEventEnvelope,
  type RemoteHostHealth,
  type RemotePrincipal,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
} from '@dsh-remote/protocol'
import { EventSequencer } from './event-sequencer.js'
import { IdempotencyStore } from './idempotency-store.js'
import { isLoopbackIp, parseProxyProtocolLine } from './proxy-protocol.js'
import type { TailscaleIdentityProvider } from './tailscale-identity.js'
import type { CaffeinateSupervisor } from './caffeinate.js'
import type { StructuredLogger } from './logger.js'
import { loopbackPrincipal } from './principal.js'

const IDEMPOTENT_REMOTE_METHODS = new Set([
  'workspace.create',
  'session.create',
  'agent-preset.select',
  'session.select-model',
  'session.prompt',
  'session.updateQueue',
  'session.cancel',
  'approval.respond',
  'question.respond',
])

export interface RemoteHostServerOptions {
  hostId: string
  adapter: DeepSeekHarnessAdapter
  logger: StructuredLogger
  host?: string
  port?: number
  userId?: string
  deviceId?: string
  serviceVersion?: string
  staticDir?: string
  maxRequestBodyBytes?: number
  caffeinate?: CaffeinateSupervisor
  identityProvider?: TailscaleIdentityProvider
  allowedDeviceIds?: Iterable<string>
}

interface ResolvedPrincipal {
  principal: RemotePrincipal
}

export class RemoteHostServer {
  private readonly httpServer: Server
  private readonly server: NetServer
  private httpPort = 0
  private readonly options: Required<Pick<RemoteHostServerOptions, 'host' | 'port' | 'userId' | 'deviceId' | 'serviceVersion' | 'maxRequestBodyBytes'>>
  private readonly hostId: string
  private readonly adapter: DeepSeekHarnessAdapter
  private readonly logger: StructuredLogger
  private readonly staticDir: string | undefined
  private readonly caffeinate: CaffeinateSupervisor | undefined
  private readonly identityProvider: TailscaleIdentityProvider | undefined
  private readonly allowedDeviceIds: Set<string> | undefined
  private readonly sourceIps = new WeakMap<Duplex, string>()
  private readonly sourceIpsByInternalPort = new Map<number, string>()
  private readonly idempotency = new IdempotencyStore()
  private readonly streamEpoch = randomUUID()
  private readonly muxSequencer = new EventSequencer({ epoch: this.streamEpoch })
  private readonly hostSequencer = new EventSequencer({ epoch: this.streamEpoch })
  private readonly sockets = new Set<Duplex>()

  constructor(options: RemoteHostServerOptions) {
    this.hostId = options.hostId
    this.adapter = options.adapter
    this.logger = options.logger
    this.staticDir = options.staticDir
    this.caffeinate = options.caffeinate
    this.identityProvider = options.identityProvider
    this.allowedDeviceIds = options.allowedDeviceIds === undefined ? undefined : new Set(options.allowedDeviceIds)
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 3090,
      userId: options.userId ?? 'tailnet-owner',
      deviceId: options.deviceId ?? 'tailscale-serve',
      serviceVersion: options.serviceVersion ?? '0.1.0',
      maxRequestBodyBytes: options.maxRequestBodyBytes ?? 1024 * 1024,
    }
    this.httpServer = createServer((request, response) => {
      void this.handleRequest(request, response).catch(error => {
        this.logger.error({ error: String(error) }, 'request handler failed')
        if (!response.headersSent) this.sendError(response, 500, 'internal', String(error))
        else response.end()
      })
    })
    this.httpServer.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch(error => {
        this.logger.error({ error: String(error) }, 'websocket upgrade failed')
        socket.destroy()
      })
    })
    this.server = createNetServer(socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      this.acceptGatewaySocket(socket)
    })
  }

  async start(): Promise<number> {
    this.caffeinate?.start()
    this.httpPort = await this.listen(this.httpServer, 0, '127.0.0.1')
    const port = await this.listen(this.server, this.options.port, this.options.host)
    this.logger.info({ host: this.options.host, port, hostId: this.hostId }, 'remote host listening')
    return port
  }

  async close(): Promise<void> {
    this.caffeinate?.stop()
    for (const socket of this.sockets) socket.destroy()
    this.adapter.close()
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close(error => error ? reject(error) : resolve())
    })
  }

  private listen(server: Server | NetServer, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('unexpected server address')
        resolve(address.port)
      })
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const physicalAddress = request.socket.remoteAddress ?? ''
    this.logger.info({
      method: request.method,
      url: request.url ?? '/',
      physicalAddress,
      sourceIp: this.sourceAddressFor(request.socket),
    }, 'http request')

    if (!this.isTrustedProxySource(physicalAddress)) {
      this.logger.warn({ remoteAddress: physicalAddress }, 'rejecting non-loopback request')
      this.sendError(response, 403, 'forbidden', 'remote host accepts loopback proxy traffic only')
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')

    if (request.method === 'GET' && url.pathname === '/api/health') {
      const principal = await this.resolvePrincipalOrReject(this.sourceAddressFor(request.socket), response)
      if (principal === null) return
      await this.handleHealth(response, principal)
      return
    }

    if (request.method === 'POST' && url.pathname.startsWith('/api/remote/')) {
      const method = url.pathname.slice('/api/remote/'.length)
      const principal = await this.resolvePrincipalOrReject(this.sourceAddressFor(request.socket), response)
      if (principal === null) return
      await this.handleRpc(method, request, response, principal)
      return
    }

    if (request.method === 'GET' && this.staticDir !== undefined) {
      await this.serveStatic(url.pathname, response)
      return
    }

    this.sendError(response, 404, 'not-found', `unknown route ${request.method ?? ''} ${url.pathname}`)
  }

  private async handleHealth(response: ServerResponse, principal: RemotePrincipal): Promise<void> {
    let harness: RemoteHostHealth['harness']
    try {
      const descriptor = await this.adapter.hostDescribe()
      harness = {
        version: descriptor.version,
        cwd: descriptor.cwd,
        ...(descriptor.provider !== undefined && { provider: descriptor.provider }),
        ...(descriptor.model !== undefined && { model: descriptor.model }),
        attachedSessions: descriptor.attachedSessions,
      }
    } catch (error) {
      harness = {
        version: 'unavailable',
        cwd: 'unavailable',
        attachedSessions: 0,
      }
      this.logger.warn({ error: String(error) }, 'harness health probe failed')
    }

    const health: RemoteHostHealth = {
      protocolVersion: PROTOCOL_VERSION,
      hostId: this.hostId,
      service: 'dsh-remote-host',
      serviceVersion: this.options.serviceVersion,
      harness,
      principal,
      uptimeMs: Math.round(process.uptime() * 1000),
    }
    this.sendJson(response, 200, health)
  }

  private async handleRpc(method: string, request: IncomingMessage, response: ServerResponse, principal: RemotePrincipal): Promise<void> {
    let body: RemoteRpcRequest
    try {
      body = await this.readJsonBody(request)
    } catch (error) {
      this.sendError(response, 400, 'bad-request', String(error))
      return
    }

    const requestId = body.requestId
    const sendResult = (result: RemoteRpcResponse['result']): void => {
      const envelope: RemoteRpcResponse = {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        method,
        result,
      }
      this.sendJson(response, 200, envelope)
    }

    if (!isRemoteMethod(method)) {
      this.logger.warn({ method }, 'remote method is not allowlisted')
      sendResult({ ok: false, error: { code: 'forbidden', message: `method ${method} is not available remotely` } })
      return
    }

    try {
      authorizeRemoteMethod(principal, method)
    } catch (error) {
      this.logger.warn({ method, principal }, 'remote capability denied')
      sendResult({ ok: false, error: { code: 'forbidden', message: String(error) } })
      return
    }

    if (IDEMPOTENT_REMOTE_METHODS.has(method) && body.idempotencyKey !== undefined) {
      const previous = this.idempotency.get(body.idempotencyKey)
      if (previous !== undefined) {
        this.logger.info({ method, requestId, idempotencyKey: body.idempotencyKey }, 'duplicate write RPC; replaying stored result')
        sendResult(previous)
        return
      }
    }

    try {
      const value = await this.dispatch(method, body.payload, principal)
      const result: RemoteRpcResponse['result'] = { ok: true, value }
      if (IDEMPOTENT_REMOTE_METHODS.has(method) && body.idempotencyKey !== undefined) {
        this.idempotency.set(body.idempotencyKey, result)
      }
      this.logger.info({
        method,
        requestId,
        userId: principal.userId,
        deviceId: principal.deviceId,
        hostId: principal.hostId,
      }, 'remote rpc ok')
      sendResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn({
        method,
        requestId,
        userId: principal.userId,
        deviceId: principal.deviceId,
        hostId: principal.hostId,
        error: message,
      }, 'remote rpc failed')
      sendResult({ ok: false, error: { code: 'remote-rpc-failed', message } })
    }
  }

  private async dispatch(method: string, payload: unknown, principal: RemotePrincipal): Promise<unknown> {
    switch (method) {
      case 'host.describe': {
        const descriptor = await this.adapter.hostDescribe()
        const value: HostDescriptor = {
          ...descriptor,
          principalUserId: principal.userId,
          principalDeviceId: principal.deviceId,
        }
        return value
      }
      case 'workspace.list':
        return await this.adapter.workspaceList()
      case 'workspace.create':
        return await this.adapter.workspaceCreate(payload as WorkspaceCreateInput)
      case 'session.list':
        return { items: await this.adapter.sessionList() }
      case 'session.search':
        return await this.adapter.sessionSearch((payload as { query: string }).query)
      case 'session.create':
        return { sessionId: await this.adapter.sessionCreate(payload as SessionCreateInput) }
      case 'agent-preset.list':
        return { items: await this.adapter.agentPresetList() }
      case 'agent-preset.select':
        return await this.adapter.agentPresetSelect(payload as AgentPresetSelectInput)
      case 'session.history':
        return await this.adapter.sessionHistory(payload as SessionHistoryQuery)
      case 'session.models':
        return await this.adapter.sessionModels((payload as { sessionId: string }).sessionId)
      case 'session.select-model':
        return await this.adapter.sessionSelectModel(payload as SessionModelSelectInput)
      case 'session.prompt':
        await this.adapter.sessionPrompt(payload as PromptInput)
        return { accepted: true }
      case 'approval.respond': {
        const decision = payload as ApprovalDecision
        return await this.adapter.approvalRespond(decision.rpcId, decision)
      }
      case 'question.respond': {
        const decision = payload as QuestionDecision
        return await this.adapter.questionRespond(decision.rpcId, decision)
      }
      default:
        throw new Error(`method ${method} is allowlisted but not implemented yet`)
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    void head
    const physicalAddress = (socket as Duplex & { remoteAddress?: string }).remoteAddress
    if (!this.isTrustedProxySource(physicalAddress)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }

    let principal: RemotePrincipal
    try {
      principal = await this.principalForSource(this.sourceAddressFor(socket))
    } catch (error) {
      this.logger.warn({ sourceIp: this.sourceAddressFor(socket), error: String(error) }, 'websocket principal rejected')
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const acceptedPath = url.pathname === '/api/remote/events.mux' || url.pathname === '/api/remote/events.host'
    if (!acceptedPath) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }

    const accept = request.headers['sec-websocket-key']
    if (typeof accept !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }

    const acceptKey = createHash('sha1')
      .update(`${accept}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')

    // Mobile clients legitimately disappear mid-upgrade. Attach the error
    // listener before the first write so EPIPE/ECONNRESET cannot crash the
    // Remote Host process.
    socket.on('error', error => {
      this.logger.warn({ path: url.pathname, error: String(error) }, 'remote websocket socket error')
      socket.destroy()
    })
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n'))

    this.logger.info({ path: url.pathname }, 'remote websocket connected')
    this.pumpEvents(url.pathname.endsWith('events.mux') ? 'mux' : 'host', socket)
  }

  private pumpEvents(kind: 'mux' | 'host', socket: Duplex): void {
    const controller = new AbortController()
    const iterator = kind === 'mux'
      ? this.adapter.muxEvents(controller.signal)
      : this.adapter.hostEvents(controller.signal)

    socket.once('close', () => controller.abort())
    socket.once('error', () => controller.abort())

    const sequencer = kind === 'mux' ? this.muxSequencer : this.hostSequencer

    void (async () => {
      try {
        for await (const message of iterator) {
          const envelope = sequencer.assign(this.hostId, kind, message)
          this.writeWebSocketText(socket, envelope)
        }
      } catch (error) {
        this.logger.warn({ kind, error: String(error) }, 'upstream event stream ended with error')
      } finally {
        controller.abort()
        if (!socket.destroyed) socket.end()
      }
    })()
  }

  private writeWebSocketText(socket: Duplex, envelope: RemoteEventEnvelope): void {
    const payload = Buffer.from(JSON.stringify(envelope))
    let frame: Buffer
    if (payload.length < 126) {
      frame = Buffer.alloc(2 + payload.length)
      frame[0] = 0x81
      frame[1] = payload.length
      payload.copy(frame, 2)
    } else if (payload.length <= 0xffff) {
      frame = Buffer.alloc(4 + payload.length)
      frame[0] = 0x81
      frame[1] = 126
      frame.writeUInt16BE(payload.length, 2)
      payload.copy(frame, 4)
    } else {
      frame = Buffer.alloc(10 + payload.length)
      frame[0] = 0x81
      frame[1] = 127
      frame.writeBigUInt64BE(BigInt(payload.length), 2)
      payload.copy(frame, 10)
    }
    if (!socket.destroyed) socket.write(frame)
  }

  private acceptGatewaySocket(socket: Socket): void {
    const physicalAddress = socket.remoteAddress ?? ''
    socket.on('error', error => {
      this.logger.warn({ physicalAddress, error: String(error) }, 'gateway socket error')
      socket.destroy()
    })
    if (!this.isTrustedProxySource(physicalAddress)) {
      this.logger.warn({ physicalAddress }, 'rejecting non-loopback gateway connection')
      socket.destroy()
      return
    }

    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const lineEnd = buffer.indexOf('\r\n')
      if (lineEnd === -1) {
        if (buffer.length > 108) socket.destroy()
        return
      }

      const line = buffer.subarray(0, lineEnd).toString('ascii')
      let remainder = buffer.subarray(lineEnd + 2)
      let sourceIp = physicalAddress
      if (line.startsWith('PROXY ')) {
        const parsed = parseProxyProtocolLine(line)
        if (parsed === undefined) {
          socket.destroy()
          return
        }
        sourceIp = parsed.sourceIp
      } else {
        // Direct HTTP: keep the request line.
        remainder = buffer
      }

      socket.removeListener('data', onData)
      const upstream = createConnection({ host: '127.0.0.1', port: this.httpPort })
      this.sourceIps.set(upstream, sourceIp)
      upstream.once('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.on('connect', () => {
        this.sourceIpsByInternalPort.set(upstream.localPort ?? -1, sourceIp)
        upstream.once('close', () => {
          this.sourceIpsByInternalPort.delete(upstream.localPort ?? -1)
        })
        if (remainder.length > 0) upstream.write(remainder)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    }
    socket.on('data', onData)
  }

  private sourceAddressFor(socket: Duplex): string {
    const remotePort = (socket as Duplex & { remotePort?: number }).remotePort
    if (remotePort !== undefined) {
      const mapped = this.sourceIpsByInternalPort.get(remotePort)
      if (mapped !== undefined) return mapped
    }
    return this.sourceIps.get(socket) ?? (socket as Duplex & { remoteAddress?: string }).remoteAddress ?? ''
  }

  private async resolvePrincipalOrReject(sourceIp: string, response: ServerResponse): Promise<RemotePrincipal | null> {
    try {
      return await this.principalForSource(sourceIp)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn({ sourceIp, error: message }, 'principal resolution rejected')
      this.sendError(response, 403, 'forbidden', message)
      return null
    }
  }

  private async principalForSource(sourceIp: string): Promise<RemotePrincipal> {
    if (isLoopbackIp(sourceIp)) {
      return loopbackPrincipal({
        userId: this.options.userId,
        deviceId: this.options.deviceId,
        hostId: this.hostId,
        deviceName: 'loopback-local',
      })
    }

    const provider = this.identityProvider
    if (provider === undefined) {
      throw new Error('no identity provider configured for non-loopback source')
    }
    const peer = await provider.resolve(sourceIp)
    if (peer === undefined) {
      throw new Error(`source ${sourceIp} is not a known Tailscale peer`)
    }
    if (this.allowedDeviceIds !== undefined && !this.allowedDeviceIds.has(peer.deviceId)) {
      throw new Error(`device ${peer.deviceId} is not allowed`)
    }
    return {
      userId: peer.userId,
      deviceId: peer.deviceId,
      hostId: this.hostId,
      roles: ['owner'],
      deviceName: peer.deviceName,
    }
  }

  private isTrustedProxySource(remoteAddress?: string): boolean {
    return remoteAddress === undefined || remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  }

  private async readJsonBody(request: IncomingMessage): Promise<RemoteRpcRequest> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > this.options.maxRequestBodyBytes) throw new Error('request body too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const value = JSON.parse(text) as unknown
    if (!isRemoteRpcRequest(value)) throw new Error('request is not a remote RPC request')
    return value
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const staticDir = this.staticDir
    if (staticDir === undefined) return
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const filePath = normalize(join(staticDir, relative))
    if (!filePath.startsWith(normalize(staticDir))) {
      this.sendError(response, 403, 'forbidden', 'path escapes static root')
      return
    }
    try {
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('not a file')
      response.writeHead(200, { 'content-type': contentType(filePath) })
      createReadStream(filePath).pipe(response)
    } catch {
      if (pathname === '/' || !pathname.includes('.')) {
        try {
          const index = join(staticDir, 'index.html')
          const info = await stat(index)
          if (!info.isFile()) throw new Error('not a file')
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          createReadStream(index).pipe(response)
          return
        } catch {
          // Fall through to 404.
        }
      }
      this.sendError(response, 404, 'not-found', `static file not found: ${pathname}`)
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(value))
  }

  private sendError(response: ServerResponse, status: number, code: string, message: string): void {
    this.sendJson(response, status, { error: { code, message } })
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.webmanifest': return 'application/manifest+json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.ico': return 'image/x-icon'
    default: return 'application/octet-stream'
  }
}

// Keep the import shape stable for consumers even if the allowlist grows.
export { REMOTE_METHOD_CAPABILITIES }
