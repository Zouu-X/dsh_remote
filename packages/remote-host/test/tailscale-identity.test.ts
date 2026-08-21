import { describe, expect, it } from 'vitest'
import { TailscaleCliIdentityProvider } from '../src/tailscale-identity.js'

const statusJson = JSON.stringify({
  Self: {
    ID: 'nTestMac111111CNTRL',
    HostName: 'test-mac',
    UserID: 123,
    TailscaleIPs: ['100.101.102.103'],
    Online: true,
  },
  Peer: {
    '100.102.103.104': {
      ID: 'nTestPhone11111CNTRL',
      HostName: 'localhost',
      DNSName: 'test-phone.example.ts.net.',
      UserID: 123,
      TailscaleIPs: ['100.102.103.104'],
      Online: true,
    },
  },
})

describe('TailscaleCliIdentityProvider', () => {
  it('maps a tailscale IP to a stable device identity', async () => {
    const provider = new TailscaleCliIdentityProvider({
      execFile: (async () => ({ stdout: statusJson })) as never,
      cacheTtlMs: 1000,
    })
    await expect(provider.resolve('100.102.103.104')).resolves.toEqual({
      deviceId: 'nTestPhone11111CNTRL',
      deviceName: 'test-phone',
      userId: 'user_123',
      tailscaleIp: '100.102.103.104',
      online: true,
    })
  })

  it('returns undefined for unknown ips', async () => {
    const provider = new TailscaleCliIdentityProvider({
      execFile: (async () => ({ stdout: statusJson })) as never,
    })
    await expect(provider.resolve('100.99.99.99')).resolves.toBeUndefined()
  })
})
