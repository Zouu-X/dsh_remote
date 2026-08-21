import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { SessionSummary } from '@dsh-remote/domain'
import { CaffeinateSupervisor } from '../src/caffeinate.js'

function session(running: boolean): SessionSummary {
  return {
    sessionId: running ? 'running_1' : 'idle_1',
    updatedAt: 1,
    running,
    blank: false,
    lastSeq: 1,
  }
}

describe('CaffeinateSupervisor', () => {
  it('starts caffeinate when a session is running and stops it when idle', async () => {
    const sessions = [session(true)]
    let childKilled = false
    const listeners = new Set<() => void>()
    const child = {
      killed: false,
      kill: vi.fn(() => { childKilled = true }),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'exit') listeners.add(listener)
        return child
      }),
    } as unknown as ChildProcess

    const supervisor = new CaffeinateSupervisor({
      adapter: { sessionList: async () => sessions } as never,
      spawn: ((command: string, args: string[]) => {
        expect(command).toBe('/usr/bin/caffeinate')
        expect(args).toEqual(['-i'])
        return child
      }) as never,
      intervalMs: 60_000,
    })

    await supervisor.tick()
    expect(supervisor.isActive()).toBe(true)

    sessions[0] = session(false)
    await supervisor.tick()
    expect(supervisor.isActive()).toBe(false)
    expect(childKilled).toBe(true)
  })

  it('does nothing when no session is running', async () => {
    const supervisor = new CaffeinateSupervisor({
      adapter: { sessionList: async () => [session(false)] } as never,
      spawn: (() => {
        throw new Error('spawn should not be called')
      }) as never,
      intervalMs: 60_000,
    })
    await supervisor.tick()
    expect(supervisor.isActive()).toBe(false)
  })
})
