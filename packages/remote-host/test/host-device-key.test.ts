import { describe, expect, it } from 'vitest'
import type { SecretStore } from '../src/keychain.js'
import { ensureHostDeviceKey, fingerprint } from '../src/host-device-key.js'

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()

  async setSecret(account: string, secret: string): Promise<void> {
    this.values.set(account, secret)
  }

  async getSecret(account: string): Promise<string | undefined> {
    return this.values.get(account)
  }

  async deleteSecret(account: string): Promise<void> {
    this.values.delete(account)
  }
}

describe('ensureHostDeviceKey', () => {
  it('creates a key pair, stores only the private key, and is idempotent', async () => {
    const store = new MemorySecretStore()
    const first = await ensureHostDeviceKey(store, 'host_1')
    expect(first.created).toBe(true)
    expect(first.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(first.fingerprint).toBe(fingerprint(first.publicKeyPem))

    const storedPrivateKey = store.values.get('host-device-key:host_1')
    expect(storedPrivateKey).toContain('BEGIN PRIVATE KEY')
    expect(storedPrivateKey).not.toContain('BEGIN PUBLIC KEY')

    const second = await ensureHostDeviceKey(store, 'host_1')
    expect(second.created).toBe(false)
    expect(second.publicKeyPem).toBe(first.publicKeyPem)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('uses a distinct keychain account per host', async () => {
    const store = new MemorySecretStore()
    await ensureHostDeviceKey(store, 'host_a')
    await ensureHostDeviceKey(store, 'host_b')
    expect(store.values.has('host-device-key:host_a')).toBe(true)
    expect(store.values.has('host-device-key:host_b')).toBe(true)
  })
})
