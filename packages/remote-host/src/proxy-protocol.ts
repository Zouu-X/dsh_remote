import { isIP } from 'node:net'

/**
 * Minimal PROXY protocol v1 parser for Tailscale Serve's HTTP reverse-proxy
 * mode. Tailscale Serve prepends one line before the HTTP request:
 *
 *   PROXY TCP4 100.102.161.14 127.0.0.1 54321 3090\r\n
 *
 * The line can only be trusted when the physical socket comes from loopback.
 */

export interface ProxyProtocolAddress {
  sourceIp: string
  sourcePort: number
  destinationIp: string
  destinationPort: number
}

export function parseProxyProtocolLine(line: string): ProxyProtocolAddress | undefined {
  const normalized = line.endsWith('\r\n') ? line.slice(0, -2) : line
  const parts = normalized.split(' ')
  if (parts.length !== 6 || parts[0] !== 'PROXY') return undefined
  const [, family, sourceIp, destinationIp, sourcePortText, destinationPortText] = parts as [string, string, string, string, string, string]
  if (family !== 'TCP4' && family !== 'TCP6') return undefined
  if (isIP(sourceIp) !== (family === 'TCP4' ? 4 : 6)) return undefined
  if (isIP(destinationIp) === 0) return undefined
  const sourcePort = Number(sourcePortText)
  const destinationPort = Number(destinationPortText)
  if (!Number.isInteger(sourcePort) || !Number.isInteger(destinationPort)) return undefined
  if (sourcePort < 0 || sourcePort > 65535 || destinationPort < 0 || destinationPort > 65535) return undefined
  return { sourceIp, sourcePort, destinationIp, destinationPort }
}

export function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}
