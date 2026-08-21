/**
 * Remote protocol v1.
 *
 * This is the A/B-stable envelope that the UI and Host layers agree on.
 * A uses it over the existing Harness WebSocket/HTTP transport; B will send
 * the same envelopes through the Relay.
 */

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export type HostId = string
export type SessionId = string
export type DeviceId = string
export type UserId = string
export type EventId = string
export type RequestId = string

export type RemoteRole = 'owner' | 'operator' | 'viewer'
export type RemoteEventStream = 'mux' | 'host'

export interface RemotePrincipal {
  /** Stable account/user id. Currently maps the tailnet owner; future account systems may map a login subject. */
  userId: UserId
  /** Stable device id. Currently derived from the trusted tailnet peer; future pairing can mint a device id. */
  deviceId: DeviceId
  /** Stable Mac host id, persisted locally and kept stable across restarts and transport changes. */
  hostId: HostId
  roles: RemoteRole[]
  /** Human-readable device name for audit/UI display. */
  deviceName?: string
}

export interface RemoteEventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  protocolVersion: ProtocolVersion
  hostId: HostId
  /** Logical downlink stream; sequence is monotonic per host+stream+epoch. */
  stream: RemoteEventStream
  /**
   * Remote Host process generation. A restart mints a new epoch and resets
   * sequence to zero; clients key their gap tracker by this field instead of
   * treating the reset as missing events.
   */
  epoch?: string
  sessionId?: SessionId
  eventId: EventId
  /** Monotonic per host+stream within one epoch; gap-detectable at the client transport boundary. */
  sequence: number
  type: TType
  payload: TPayload
  timestamp: string
}

export interface RemoteRpcRequest<TMethod extends string = string, TPayload = unknown> {
  protocolVersion: ProtocolVersion
  requestId: RequestId
  method: TMethod
  payload: TPayload
  /**
   * Client-generated idempotency key for write operations. Retries with the
   * same key must not execute the operation twice.
   */
  idempotencyKey?: string
}

export type RemoteRpcResult<TPayload = unknown> =
  | { ok: true; value: TPayload }
  | { ok: false; error: RemoteRpcError }

export interface RemoteRpcResponse<TMethod extends string = string, TPayload = unknown> {
  protocolVersion: ProtocolVersion
  requestId: RequestId
  method: TMethod
  result: RemoteRpcResult<TPayload>
}

export interface RemoteRpcError {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Remote-host health payload. */
export interface RemoteHostHealth {
  protocolVersion: ProtocolVersion
  hostId: HostId
  service: 'dsh-remote-host'
  serviceVersion: string
  harness: {
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
  }
  principal: RemotePrincipal
  uptimeMs: number
}

export function isRemoteEventEnvelope(value: unknown): value is RemoteEventEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RemoteEventEnvelope>
  return (
    candidate.protocolVersion === PROTOCOL_VERSION
    && typeof candidate.hostId === 'string'
    && (candidate.epoch === undefined || typeof candidate.epoch === 'string')
    && (candidate.sessionId === undefined || typeof candidate.sessionId === 'string')
    && typeof candidate.eventId === 'string'
    && typeof candidate.sequence === 'number'
    && Number.isInteger(candidate.sequence)
    && typeof candidate.type === 'string'
    && typeof candidate.timestamp === 'string'
  )
}

export function isRemoteRpcRequest(value: unknown): value is RemoteRpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RemoteRpcRequest>
  return (
    candidate.protocolVersion === PROTOCOL_VERSION
    && typeof candidate.requestId === 'string'
    && typeof candidate.method === 'string'
    && 'payload' in candidate
    && (candidate.idempotencyKey === undefined || typeof candidate.idempotencyKey === 'string')
  )
}

export function isRemoteRpcResponse(value: unknown): value is RemoteRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RemoteRpcResponse>
  return (
    candidate.protocolVersion === PROTOCOL_VERSION
    && typeof candidate.requestId === 'string'
    && typeof candidate.method === 'string'
    && typeof candidate.result === 'object'
    && candidate.result !== null
  )
}

export function newEventId(): EventId {
  return crypto.randomUUID()
}

export function newRequestId(): RequestId {
  return crypto.randomUUID()
}
