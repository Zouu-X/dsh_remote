import type { HostId, RemoteEventEnvelope } from '@dsh-remote/protocol'

export type SequenceAcceptance =
  | { kind: 'new'; envelope: RemoteEventEnvelope; hadGap: boolean; gapFrom?: number; gapTo?: number }
  | { kind: 'duplicate'; envelope: RemoteEventEnvelope }
  | { kind: 'gap'; envelope: RemoteEventEnvelope; from: number; to: number }

export interface SequenceTrackerState {
  lastSequence: number
  seenEventIds: Set<string>
}

/**
 * Client transport boundary bookkeeping: dedupe by eventId and detect
 * gaps by host+stream+epoch monotonic sequence.
 *
 * The tracker is scoped to `host + stream + epoch`. A Remote Host restart
 * mints a new epoch and resets its sequence, which must rebaseline cleanly
 * instead of looking like a gap (or, worse, dropping the first new frames as
 * duplicates).
 */
export class RemoteSequenceTracker {
  private readonly streams = new Map<string, SequenceTrackerState>()

  accept(envelope: RemoteEventEnvelope): SequenceAcceptance {
    const state = this.stateFor(envelope)
    if (state.seenEventIds.has(envelope.eventId)) {
      return { kind: 'duplicate', envelope }
    }
    state.seenEventIds.add(envelope.eventId)

    const last = state.lastSequence
    if (last === -1) {
      // First observed frame on this stream+epoch establishes the baseline.
      // A mid-stream connect is normal and must not report 0..firstSeq as a
      // gap.
      state.lastSequence = envelope.sequence
      return { kind: 'new', envelope, hadGap: false }
    }

    if (envelope.sequence <= last) {
      // Duplicate/late delivery with a different event id is tolerated.
      return { kind: 'duplicate', envelope }
    }

    const hadGap = envelope.sequence > last + 1
    const acceptance: SequenceAcceptance = hadGap
      ? { kind: 'gap', envelope, from: last + 1, to: envelope.sequence - 1 }
      : { kind: 'new', envelope, hadGap: false }

    state.lastSequence = envelope.sequence
    return acceptance
  }

  lastSequenceFor(
    hostId: HostId,
    stream: RemoteEventEnvelope['stream'],
    epoch?: string,
  ): number | undefined {
    return this.streams.get(this.keyFor(hostId, stream, epoch))?.lastSequence
  }

  reset(): void {
    this.streams.clear()
  }

  /** Rebaseline one host stream after a new WebSocket connection. */
  resetStream(hostId: HostId, stream: RemoteEventEnvelope['stream']): void {
    const prefix = `${hostId}:${stream}:`
    for (const key of [...this.streams.keys()]) {
      if (key.startsWith(prefix)) this.streams.delete(key)
    }
  }

  private stateFor(envelope: RemoteEventEnvelope): SequenceTrackerState {
    const key = this.keyFor(envelope.hostId, envelope.stream, envelope.epoch)
    let state = this.streams.get(key)
    if (state === undefined) {
      state = { lastSequence: -1, seenEventIds: new Set() }
      this.streams.set(key, state)
    }
    return state
  }

  private keyFor(
    hostId: HostId,
    stream: RemoteEventEnvelope['stream'],
    epoch: string | undefined,
  ): string {
    return `${hostId}:${stream}:${epoch ?? ''}`
  }
}
