import { describe, expect, it } from 'vitest'
import { groupSessionsByWorkspace, reusableBlankSession, visibleTaskSessions } from '../src/index.js'
import type { ApprovalDecision, RemoteApiMap, SessionEventView } from '../src/index.js'

describe('remote domain', () => {
  it('approval decisions carry the upstream rpcId for idempotent responses', () => {
    const decision: ApprovalDecision = {
      sessionId: 'session_1',
      approvalId: 'approval_1',
      rpcId: 'rpc_1',
      outcome: 'allowed-once',
    }
    expect(decision.rpcId).toBe('rpc_1')
  })

  it('remote API map keys are the stable transport method names', () => {
    expect('session.prompt' satisfies keyof RemoteApiMap).toBe('session.prompt')
    expect('approval.respond' satisfies keyof RemoteApiMap).toBe('approval.respond')
  })

  it('session event view is version-independent of upstream internals', () => {
    const event: SessionEventView = {
      eventId: 'event_1',
      sessionId: 'session_1',
      sequence: 1,
      type: 'assistant/chunk',
      payload: { chunk: 'ok' },
      timestamp: new Date().toISOString(),
    }
    expect(event.type).toBe('assistant/chunk')
  })

  it('groups sessions by workspace and leaves ungrouped sessions last', () => {
    const groups = groupSessionsByWorkspace(
      [
        { sessionId: 's1', updatedAt: 2, running: false, blank: false, lastSeq: 1, workspaceId: 'ws_a' },
        { sessionId: 's2', updatedAt: 3, running: true, blank: false, lastSeq: 2, workspaceId: 'ws_b' },
        { sessionId: 's3', updatedAt: 4, running: false, blank: false, lastSeq: 3 },
      ],
      [
        { workspaceId: 'ws_a', path: '/a', title: 'Alpha', sessionIds: ['s1'], createdAt: '', updatedAt: '' },
        { workspaceId: 'ws_b', path: '/b', title: 'Beta', sessionIds: ['s2'], createdAt: '', updatedAt: '' },
      ],
    )
    expect(groups.map(group => group.title)).toEqual(['Alpha', 'Beta', '未分组'])
    expect(groups.map(group => group.sessions.length)).toEqual([1, 1, 1])
  })

  it('matches desktop visibility by hiding blank, archived, and subagent sessions', () => {
    const visible = visibleTaskSessions(
      [
        { sessionId: 'started', updatedAt: 5, running: false, blank: false, lastSeq: 1 },
        { sessionId: 'blank', updatedAt: 4, running: false, blank: true, lastSeq: -1 },
        { sessionId: 'archived', updatedAt: 3, running: false, blank: false, lastSeq: 2 },
        { sessionId: 'child', updatedAt: 2, running: false, blank: false, origin: 'subagent', lastSeq: 3 },
      ],
      ['archived'],
    )
    expect(visible.map(session => session.sessionId)).toEqual(['started'])
  })

  it('reuses only an active workspace-owned blank session', () => {
    const sessions = [
      { sessionId: 'archived', workspaceId: 'ws', updatedAt: 5, running: false, blank: true, lastSeq: -1 },
      { sessionId: 'other', workspaceId: 'other', updatedAt: 4, running: false, blank: true, lastSeq: -1 },
      { sessionId: 'reusable', workspaceId: 'ws', updatedAt: 3, running: false, blank: true, lastSeq: -1 },
      { sessionId: 'started', workspaceId: 'ws', updatedAt: 2, running: false, blank: false, lastSeq: 4 },
    ]
    expect(reusableBlankSession(sessions, 'ws', ['archived'])?.sessionId).toBe('reusable')
  })
})
