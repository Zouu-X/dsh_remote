import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import type { StructuredLogger } from '../src/logger.js'
import type { TailscaleIdentityProvider } from '../src/tailscale-identity.js'
import { RemoteHostServer } from '../src/server.js'

const logger: StructuredLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function fakeAdapter(): DeepSeekHarnessAdapter {
  return {
    hostDescribe: async () => ({
      hostId: 'host_1',
      version: '0.0.1',
      cwd: '/tmp',
      attachedSessions: 0,
      principalUserId: '',
      principalDeviceId: '',
    }),
    close: () => {},
  } as unknown as DeepSeekHarnessAdapter
}

function identityProvider(): TailscaleIdentityProvider {
  return {
    resolve: async ip => ip === '100.102.161.14'
      ? {
          deviceId: 'device_phone',
          deviceName: 'test-phone',
          userId: 'user_1',
          tailscaleIp: ip,
          online: true,
        }
      : undefined,
  }
}

async function startServer(provider?: TailscaleIdentityProvider, allowedDeviceIds?: string[]): Promise<{ server: RemoteHostServer; port: number }> {
  const options: ConstructorParameters<typeof RemoteHostServer>[0] = {
    hostId: 'host_1',
    adapter: fakeAdapter(),
    logger,
    port: 0,
  }
  if (provider !== undefined) options.identityProvider = provider
  if (allowedDeviceIds !== undefined) options.allowedDeviceIds = allowedDeviceIds
  const server = new RemoteHostServer(options)
  const port = await server.start()
  return { server, port }
}

function decodeChunked(response: string): string {
  const headerEnd = response.indexOf('\r\n\r\n')
  if (headerEnd === -1) return ''
  const body = response.slice(headerEnd + 4)
  if (!/^[0-9a-f]+\r\n/i.test(body)) return body
  let decoded = ''
  let cursor = 0
  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor)
    if (lineEnd === -1) break
    const sizeText = body.slice(cursor, lineEnd).split(';')[0] ?? ''
    const size = Number.parseInt(sizeText, 16)
    if (Number.isNaN(size) || size === 0) break
    decoded += body.slice(lineEnd + 2, lineEnd + 2 + size)
    cursor = lineEnd + 2 + size + 2
  }
  return decoded
}

function rawHealth(port: number, prefix = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const request = `${prefix}GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    let response = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(decodeChunked(response)))
    socket.on('error', reject)
  })
}

describe('RemoteHostServer identity resolution', () => {
  it('resolves a PROXY protocol source ip through the identity provider', async () => {
    const { server, port } = await startServer(identityProvider())
    try {
      const response = await rawHealth(port, 'PROXY TCP4 100.102.161.14 127.0.0.1 54321 3090\r\n')
      const body = JSON.parse(response) as { principal: { deviceId: string; deviceName?: string } }
      expect(body.principal.deviceId).toBe('device_phone')
      expect(body.principal.deviceName).toBe('test-phone')
    } finally {
      await server.close()
    }
  })

  it('rejects a known device that is not in the allowlist', async () => {
    const { server, port } = await startServer(identityProvider(), ['device_mac'])
    try {
      const response = await rawHealth(port, 'PROXY TCP4 100.102.161.14 127.0.0.1 54321 3090\r\n')
      const body = JSON.parse(response) as { error: { code: string } }
      expect(body.error.code).toBe('forbidden')
    } finally {
      await server.close()
    }
  })

  it('keeps direct loopback traffic as the local principal', async () => {
    const { server, port } = await startServer(identityProvider())
    try {
      const response = await rawHealth(port)
      const body = JSON.parse(response) as { principal: { deviceId: string } }
      expect(body.principal.deviceId).toBe('tailscale-serve')
    } finally {
      await server.close()
    }
  })
})
