import { describe, expect, it } from 'vitest'
import type { RemoteEventEnvelope } from '@dsh-remote/protocol'
import { RemoteSequenceTracker } from '../src/sequence-tracker.js'

function envelope(
  sequence: number,
  eventId = `event_${sequence}`,
  epoch = 'epoch_1',
): RemoteEventEnvelope {
  return {
    protocolVersion: 1,
    hostId: 'host_1',
    stream: 'mux',
    epoch,
    eventId,
    sequence,
    type: 'session/event',
    payload: {},
    timestamp: new Date().toISOString(),
  }
}

describe('RemoteSequenceTracker', () => {
  it('accepts monotonic events and deduplicates by eventId', () => {
    const tracker = new RemoteSequenceTracker()
    expect(tracker.accept(envelope(0)).kind).toBe('new')
    expect(tracker.accept(envelope(0)).kind).toBe('duplicate')
    expect(tracker.accept(envelope(1)).kind).toBe('new')
  })

  it('uses the first frame of a stream as a baseline', () => {
    const tracker = new RemoteSequenceTracker()
    expect(tracker.accept(envelope(10)).kind).toBe('new')
    expect(tracker.accept(envelope(11)).kind).toBe('new')
  })

  it('detects a sequence gap', () => {
    const tracker = new RemoteSequenceTracker()
    tracker.accept(envelope(0))
    const result = tracker.accept(envelope(4))
    expect(result).toMatchObject({ kind: 'gap', from: 1, to: 3 })
  })

  it('tracks sequences per host and stream', () => {
    const tracker = new RemoteSequenceTracker()
    tracker.accept(envelope(10))
    const otherHost = envelope(0)
    otherHost.hostId = 'host_2'
    otherHost.eventId = 'other_host_0'
    expect(tracker.accept(otherHost).kind).toBe('new')

    const otherStream = envelope(0)
    otherStream.stream = 'host'
    otherStream.eventId = 'other_stream_0'
    expect(tracker.accept(otherStream).kind).toBe('new')

    expect(tracker.lastSequenceFor('host_1', 'mux', 'epoch_1')).toBe(10)
    expect(tracker.lastSequenceFor('host_1', 'host', 'epoch_1')).toBe(0)
    expect(tracker.lastSequenceFor('host_2', 'mux', 'epoch_1')).toBe(0)
  })

  it('rebaselines when the remote host epoch changes', () => {
    const tracker = new RemoteSequenceTracker()
    expect(tracker.accept(envelope(20)).kind).toBe('new')

    const nextEpoch = envelope(0, 'event_0_next_epoch', 'epoch_2')
    expect(tracker.accept(nextEpoch).kind).toBe('new')
    expect(tracker.lastSequenceFor('host_1', 'mux', 'epoch_2')).toBe(0)
  })

  it('supports explicit per-connection rebaseline', () => {
    const tracker = new RemoteSequenceTracker()
    expect(tracker.accept(envelope(20)).kind).toBe('new')

    tracker.resetStream('host_1', 'mux')
    expect(tracker.lastSequenceFor('host_1', 'mux', 'epoch_1')).toBeUndefined()
    expect(tracker.accept(envelope(4, 'event_4_reconnect', 'epoch_1')).kind).toBe('new')
  })
})
