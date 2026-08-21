import { createHash } from 'node:crypto'
import type { HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import type { HostId, RemoteEventEnvelope, RemoteEventStream } from '@dsh-remote/protocol'

export interface UpstreamFrame {
  type: string
  sessionId?: string
  [key: string]: unknown
}

export interface UpstreamSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export class MonotonicSequence {
  private nextValue = 0

  next(): number {
    return this.nextValue++
  }
}

function hashPayload(payload: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(payload) ?? String(payload)
  } catch {
    serialized = String(payload)
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32)
}

/**
 * Stable logical key for one upstream frame. Connection-local baseline frames
 * (for example `session/subscribed` or `session/queue` snapshots) use a
 * content hash so every downstream WebSocket observes the same sequence for
 * the same snapshot instead of consuming one sequence per connection.
 */
export function upstreamEventKey(message: HarnessServerRequest): string {
  const frame = message.payload as UpstreamFrame
  const type = frame.type || message.method
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : 'host'

  if (frame.type === 'session/event') {
    const event = frame.event as UpstreamSessionEvent
    return `session-event:${sessionId}:${Number.isInteger(event.seq) ? event.seq : message.rpcId}`
  }
  if (frame.type === 'session/subscribed') {
    // Connection-local watermark. Reuse the session-scoped key so a second
    // downstream WebSocket does not consume a fresh sequence just because
    // `lastSeq` moved since the first connection.
    return `session-subscribed:${sessionId}`
  }
  if (frame.type === 'approval/requested' || frame.type === 'approval/resolved') {
    return `${frame.type}:${sessionId}:${String(frame.approvalId ?? message.rpcId)}`
  }
  if (frame.type === 'question/requested') {
    return `question-requested:${sessionId}:${message.rpcId}`
  }
  if (frame.type === 'question/resolved') {
    return `question-resolved:${sessionId}:${String(frame.questionRpcId ?? message.rpcId)}`
  }
  return `${type}:${sessionId}:${hashPayload(frame)}`
}

function eventIdFor(hostId: HostId, message: HarnessServerRequest): string {
  const frame = message.payload as UpstreamFrame
  if (frame.type === 'session/event') {
    const event = frame.event as UpstreamSessionEvent
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : 'host'
    return `${hostId}:${sessionId}:${event.seq}`
  }
  return `${hostId}:${upstreamEventKey(message)}`
}

/**
 * Translates one upstream Harness server-request into one versioned remote
 * envelope. `sequence` is monotonic per host+stream within `epoch`; `eventId`
 * is deterministic for replayable upstream facts so reconnects never create
 * duplicates.
 */
export function toRemoteEnvelope(
  hostId: HostId,
  stream: RemoteEventStream,
  message: HarnessServerRequest,
  sequence: number,
  epoch?: string,
): RemoteEventEnvelope {
  const frame = message.payload as UpstreamFrame
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
  const timestamp = new Date().toISOString()
  const eventId = eventIdFor(hostId, message)
  let type: string
  let payload: unknown

  if (frame.type === 'session/event') {
    const event = frame.event as UpstreamSessionEvent
    type = 'session/event'
    payload = {
      event,
      ...(frame.view !== undefined && { view: frame.view }),
    }
  } else if (frame.type === 'approval/requested') {
    type = 'approval/requested'
    payload = {
      sessionId,
      rpcId: message.rpcId,
      approvalId: frame.approvalId,
      toolName: frame.toolName,
      callId: frame.callId,
      reason: frame.reason,
    }
  } else if (frame.type === 'question/requested') {
    type = 'question/requested'
    payload = {
      sessionId,
      rpcId: message.rpcId,
      questions: frame.questions,
    }
  } else {
    type = frame.type || message.method
    payload = frame
  }

  return {
    protocolVersion: 1,
    hostId,
    stream,
    ...(epoch !== undefined && { epoch }),
    ...(sessionId !== undefined && { sessionId }),
    eventId,
    sequence,
    type,
    payload,
    timestamp,
  }
}
