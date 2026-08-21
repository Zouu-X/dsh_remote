import { describe, expect, it } from 'vitest'
import type { RemotePrincipal } from '@dsh-remote/protocol'
import {
  FORBIDDEN_REMOTE_METHODS,
  REMOTE_METHOD_CAPABILITIES,
  authorizeRemoteMethod,
  can,
  isRemoteMethod,
} from '../src/index.js'

const owner: RemotePrincipal = {
  userId: 'user_1',
  deviceId: 'device_1',
  hostId: 'host_1',
  roles: ['owner'],
}

const viewer: RemotePrincipal = {
  userId: 'user_1',
  deviceId: 'device_2',
  hostId: 'host_1',
  roles: ['viewer'],
}

describe('remote capability policy', () => {
  it('owner can send prompts', () => {
    expect(can(owner, 'session:prompt')).toBe(true)
    expect(() => authorizeRemoteMethod(owner, 'session.prompt')).not.toThrow()
  })

  it('viewer cannot create sessions', () => {
    expect(can(viewer, 'session:create')).toBe(false)
    expect(() => authorizeRemoteMethod(viewer, 'session.create')).toThrow(/lacks capability/)
  })

  it('remote allowlist excludes privileged upstream methods', () => {
    for (const method of FORBIDDEN_REMOTE_METHODS) {
      expect(isRemoteMethod(method)).toBe(false)
    }
    expect(REMOTE_METHOD_CAPABILITIES).toMatchObject({
      'session.list': 'session:read',
      'session.prompt': 'session:prompt',
      'approval.respond': 'approval:respond',
    })
  })
})
