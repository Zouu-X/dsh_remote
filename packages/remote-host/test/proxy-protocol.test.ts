import { describe, expect, it } from 'vitest'
import { isLoopbackIp, parseProxyProtocolLine } from '../src/proxy-protocol.js'

describe('parseProxyProtocolLine', () => {
  it('parses a Tailscale Serve PROXY v1 line', () => {
    expect(parseProxyProtocolLine('PROXY TCP4 100.102.161.14 127.0.0.1 54321 3090\r\n')).toEqual({
      sourceIp: '100.102.161.14',
      sourcePort: 54321,
      destinationIp: '127.0.0.1',
      destinationPort: 3090,
    })
  })

  it('rejects malformed lines', () => {
    expect(parseProxyProtocolLine('PROXY TCP4 100.102.161.14 127.0.0.1 nope 3090\r\n')).toBeUndefined()
    expect(parseProxyProtocolLine('GET / HTTP/1.1\r\n')).toBeUndefined()
  })
})

describe('isLoopbackIp', () => {
  it('recognizes loopback addresses', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true)
    expect(isLoopbackIp('::1')).toBe(true)
    expect(isLoopbackIp('100.102.161.14')).toBe(false)
  })
})
