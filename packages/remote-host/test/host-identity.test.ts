import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateHostIdentity, persistHostDeviceKey } from '../src/host-identity.js'

describe('host identity persistence', () => {
  it('persists the public key without replacing the host id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-identity-'))
    const stateFile = join(dir, 'host-state.json')
    try {
      const first = loadOrCreateHostIdentity({ stateFile })
      const updated = persistHostDeviceKey(stateFile, {
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        fingerprint: 'abc123',
      })
      expect(updated.hostId).toBe(first.hostId)
      expect(updated.devicePublicKey).toContain('BEGIN PUBLIC KEY')
      expect(updated.deviceKeyFingerprint).toBe('abc123')

      const reloaded = loadOrCreateHostIdentity({ stateFile })
      expect(reloaded).toEqual(updated)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the state file with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-identity-'))
    const stateFile = join(dir, 'host-state.json')
    try {
      loadOrCreateHostIdentity({ stateFile })
      expect(statSync(stateFile).mode & 0o777).toBe(0o600)
      // JSON file contents never include a private key.
      expect(readFileSync(stateFile, 'utf8')).not.toContain('PRIVATE KEY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
