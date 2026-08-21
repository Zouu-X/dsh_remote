import { randomUUID } from 'node:crypto'
import type { HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import type { HostId, RemoteEventEnvelope, RemoteEventStream } from '@dsh-remote/protocol'
import { MonotonicSequence, toRemoteEnvelope, upstreamEventKey } from './event-enveloper.js'

export interface EventSequencerOptions {
  /** Stable identifier for this Remote Host process generation. */
  epoch?: string
  /** Upper bound for the replay-key cache. */
  maxCacheSize?: number
}

/**
 * Allocates one remote transport sequence per upstream logical event.
 *
 * Every downstream WebSocket has its own upstream Harness connection, and the
 * same logical frame can arrive through several of those connections. This
 * class keeps a bounded key -> sequence cache so those duplicates share one
 * sequence instead of consuming several sequence numbers and manufacturing
 * false client-side gaps.
 */
export class EventSequencer {
  readonly epoch: string
  private readonly sequence = new MonotonicSequence()
  private readonly cache = new Map<string, number>()
  private readonly maxCacheSize: number

  constructor(options: EventSequencerOptions = {}) {
    this.epoch = options.epoch ?? randomUUID()
    this.maxCacheSize = options.maxCacheSize ?? 20_000
  }

  assign(hostId: HostId, stream: RemoteEventStream, message: HarnessServerRequest): RemoteEventEnvelope {
    const key = `${hostId}:${stream}:${upstreamEventKey(message)}`
    let sequence = this.cache.get(key)
    if (sequence === undefined) {
      sequence = this.sequence.next()
      if (this.cache.size >= this.maxCacheSize) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      this.cache.set(key, sequence)
    }
    return toRemoteEnvelope(hostId, stream, message, sequence, this.epoch)
  }
}
