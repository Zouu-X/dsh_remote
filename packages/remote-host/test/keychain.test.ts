import { describe, expect, it, vi } from 'vitest'
import { MacKeychainSecretStore } from '../src/keychain.js'

describe('MacKeychainSecretStore', () => {
  it('writes a generic password with service and account', async () => {
    const execFile = vi.fn(async () => ({ stdout: '' }))
    const store = new MacKeychainSecretStore({
      service: 'test.service',
      execFile: execFile as never,
    })
    await store.setSecret('account_1', 'secret_value')
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-a', 'account_1',
        '-s', 'test.service',
        '-U',
        '-w', 'base64:c2VjcmV0X3ZhbHVl',
      ],
      expect.anything(),
    )
  })

  it('reads and trims a stored secret', async () => {
    const store = new MacKeychainSecretStore({
      service: 'test.service',
      execFile: (async () => ({ stdout: 'secret_value\n' })) as never,
    })
    await expect(store.getSecret('account_1')).resolves.toBe('secret_value')
  })

  it('returns undefined when the item is absent', async () => {
    const store = new MacKeychainSecretStore({
      execFile: (async () => {
        throw new Error('not found')
      }) as never,
    })
    await expect(store.getSecret('missing')).resolves.toBeUndefined()
  })

  it('decodes the base64 wrapper from keychain output', async () => {
    const store = new MacKeychainSecretStore({
      execFile: (async () => ({ stdout: 'base64:c2VjcmV0X3ZhbHVl\n' })) as never,
    })
    await expect(store.getSecret('account_1')).resolves.toBe('secret_value')
  })

  it('decodes legacy hex-encoded PEM values', async () => {
    const pem = '-----BEGIN TEST KEY-----\nlegacy\n-----END TEST KEY-----'
    const hex = Buffer.from(pem).toString('hex')
    const store = new MacKeychainSecretStore({
      execFile: (async () => ({ stdout: `${hex}\n` })) as never,
    })
    await expect(store.getSecret('legacy')).resolves.toBe(pem)
  })

  it('never leaks the secret in write error messages', async () => {
    const store = new MacKeychainSecretStore({
      execFile: (async () => {
        throw new Error('/usr/bin/security ... -w super-secret-value')
      }) as never,
    })
    const failure = await store.setSecret('account_1', 'super-secret-value').catch(error => String(error))
    expect(failure).not.toContain('super-secret-value')
    expect(failure).toContain('macOS Keychain write failed')
  })
})
