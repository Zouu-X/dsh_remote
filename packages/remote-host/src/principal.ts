import type { RemotePrincipal } from '@dsh-remote/protocol'

export interface A1PrincipalOptions {
  userId: string
  deviceId: string
  hostId: string
  deviceName?: string
}

/**
 * A1 trust model: the Remote Host Adapter listens on loopback only. Any
 * request that reaches it has already been accepted by Tailscale Serve and
 * therefore by the tailnet ACL. Tailscale `--trusted-host` is not identity;
 * this principal is deliberately coarse for the single-user MVP. B will mint
 * per-device tokens and resolve the same RemotePrincipal type.
 */
export function loopbackPrincipal(options: A1PrincipalOptions): RemotePrincipal {
  return {
    userId: options.userId,
    deviceId: options.deviceId,
    hostId: options.hostId,
    roles: ['owner'],
    ...(options.deviceName !== undefined && { deviceName: options.deviceName }),
  }
}
