import { describe, expect, it } from 'vitest'
import type { HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import { EventSequencer } from '../src/event-sequencer.js'

function sessionEvent(rpcId: string, seq: number): HarnessServerRequest {
  return {
    type: 'server-request',
    rpcId,
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId: 'session_1',
      event: { type: 'assistant/chunk', seq, time: 1700000000000, data: { chunk: 'x' } },
    },
  }
}

describe('EventSequencer', () => {
  it('reuses one sequence for the same logical event seen by two downstream pumps', () => {
    const sequencer = new EventSequencer({ epoch: 'epoch_1' })
    const first = sequencer.assign('host_1', 'mux', sessionEvent('rpc_a', 42))
    const second = sequencer.assign('host_1', 'mux', sessionEvent('rpc_b', 42))
    expect(first.sequence).toBe(0)
    expect(second.sequence).toBe(0)
    expect(first.eventId).toBe(second.eventId)
    expect(second.epoch).toBe('epoch_1')
  })

  it('allocates a new sequence for a new logical event', () => {
    const sequencer = new EventSequencer({ epoch: 'epoch_1' })
    const first = sequencer.assign('host_1', 'mux', sessionEvent('rpc_a', 42))
    const second = sequencer.assign('host_1', 'mux', sessionEvent('rpc_b', 43))
    expect(first.sequence).toBe(0)
    expect(second.sequence).toBe(1)
  })

  it('keeps sequence allocation scoped per stream', () => {
    const muxSequencer = new EventSequencer({ epoch: 'epoch_1' })
    const hostSequencer = new EventSequencer({ epoch: 'epoch_1' })
    const mux = muxSequencer.assign('host_1', 'mux', sessionEvent('rpc_mux', 1))
    const host = hostSequencer.assign('host_1', 'host', sessionEvent('rpc_host', 1))
    expect(mux.sequence).toBe(0)
    expect(host.sequence).toBe(0)
  })
})
