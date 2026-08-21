import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TailscalePeerIdentity {
  /** Stable node id (Tailscale `ID`, e.g. n0123456789ABCDE). */
  deviceId: string
  /** Human-readable peer hostname, e.g. test-phone. */
  deviceName: string
  /** Tailscale UserID. Devices in the owner's tailnet share one UserID in the current single-user setup. */
  userId: string
  tailscaleIp: string
  online: boolean
}

export interface TailscaleIdentityProvider {
  resolve(sourceIp: string): Promise<TailscalePeerIdentity | undefined>
}

interface TailscaleNode {
  ID?: string
  HostName?: string
  DNSName?: string
  UserID?: number
  TailscaleIPs?: string[]
  Online?: boolean
}

function displayName(node: TailscaleNode): string {
  const hostName = node.HostName ?? ''
  if (hostName !== '' && hostName.toLowerCase() !== 'localhost') return hostName
  const dnsName = node.DNSName ?? ''
  const firstLabel = dnsName.split('.')[0] ?? ''
  return firstLabel || hostName
}

interface TailscaleStatus {
  Self?: TailscaleNode
  Peer?: Record<string, TailscaleNode>
}

export interface TailscaleCliIdentityProviderOptions {
  command?: string
  execFile?: typeof execFileAsync
  cacheTtlMs?: number
  logger?: { warn(fields: Record<string, unknown>, message: string): void }
}

export class TailscaleCliIdentityProvider implements TailscaleIdentityProvider {
  private readonly command: string
  private readonly exec: typeof execFileAsync
  private readonly cacheTtlMs: number
  private readonly logger?: TailscaleCliIdentityProviderOptions['logger']
  private cache = new Map<string, { expiresAt: number; identity: TailscalePeerIdentity | undefined }>()

  constructor(options: TailscaleCliIdentityProviderOptions = {}) {
    this.command = options.command ?? 'tailscale'
    this.exec = options.execFile ?? execFileAsync
    this.cacheTtlMs = options.cacheTtlMs ?? 15_000
    this.logger = options.logger
  }

  async resolve(sourceIp: string): Promise<TailscalePeerIdentity | undefined> {
    const cached = this.cache.get(sourceIp)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.identity
    if (cached !== undefined) this.cache.delete(sourceIp)

    try {
      const { stdout } = await this.exec(this.command, ['status', '--json'], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const status = JSON.parse(stdout) as TailscaleStatus
      const identity = this.findNode(status, sourceIp)
      this.cache.set(sourceIp, { expiresAt: Date.now() + this.cacheTtlMs, identity })
      return identity
    } catch (error) {
      this.logger?.warn({ sourceIp, error: String(error) }, 'tailscale identity lookup failed')
      return undefined
    }
  }

  private findNode(status: TailscaleStatus, sourceIp: string): TailscalePeerIdentity | undefined {
    const candidates: TailscaleNode[] = []
    if (status.Self !== undefined) candidates.push(status.Self)
    if (status.Peer !== undefined) candidates.push(...Object.values(status.Peer))
    for (const node of candidates) {
      if (!node.TailscaleIPs?.includes(sourceIp)) continue
      if (typeof node.ID !== 'string' || typeof node.HostName !== 'string' || typeof node.UserID !== 'number') continue
      return {
        deviceId: node.ID,
        deviceName: displayName(node),
        userId: `user_${node.UserID}`,
        tailscaleIp: sourceIp,
        online: node.Online === true,
      }
    }
    return undefined
  }
}
