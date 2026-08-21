import type { RemotePrincipal } from '@dsh-remote/protocol'

export interface LoopbackPrincipalOptions {
  userId: string
  deviceId: string
  hostId: string
  deviceName?: string
}

/**
 * Current trust model: the Remote Host Adapter listens on loopback only. Any
 * request that reaches it has already been accepted by Tailscale Serve and
 * therefore by the tailnet ACL. Tailscale `--trusted-host` is not identity;
 * this principal is deliberately coarse for the single-user setup. Future
 * deployments can resolve the same RemotePrincipal from per-device tokens.
 */
export function loopbackPrincipal(options: LoopbackPrincipalOptions): RemotePrincipal {
  return {
    userId: options.userId,
    deviceId: options.deviceId,
    hostId: options.hostId,
    roles: ['owner'],
    ...(options.deviceName !== undefined && { deviceName: options.deviceName }),
  }
}
