import type { RemotePrincipal, RemoteRole } from '@dsh-remote/protocol'

/**
 * Capability policy. Business code checks capabilities, never "am I on
 * Tailscale" or a hostname. A and B both resolve a RemotePrincipal and pass
 * it through the same authorize() function.
 */

export type RemoteCapability =
  | 'host:read'
  | 'workspace:read'
  | 'session:read'
  | 'session:create'
  | 'session:prompt'
  | 'session:steer'
  | 'approval:respond'
  | 'question:respond'
  | 'host:admin'

export const ROLE_CAPABILITIES: Record<RemoteRole, readonly RemoteCapability[]> = {
  owner: [
    'host:read',
    'workspace:read',
    'session:read',
    'session:create',
    'session:prompt',
    'session:steer',
    'approval:respond',
    'question:respond',
    'host:admin',
  ],
  operator: [
    'host:read',
    'workspace:read',
    'session:read',
    'session:create',
    'session:prompt',
    'session:steer',
    'approval:respond',
    'question:respond',
  ],
  viewer: [
    'host:read',
    'workspace:read',
    'session:read',
  ],
}

/**
 * Remote RPC allowlist. Everything else stays on the local Harness UI and is
 * never proxied through the Remote Host Adapter.
 */
export const REMOTE_METHOD_CAPABILITIES = {
  'host.describe': 'host:read',
  'workspace.list': 'workspace:read',
  'workspace.create': 'session:create',
  'session.list': 'session:read',
  'session.search': 'session:read',
  'session.history': 'session:read',
  'session.create': 'session:create',
  'session.prompt': 'session:prompt',
  'session.updateQueue': 'session:prompt',
  'session.cancel': 'session:steer',
  'approval.respond': 'approval:respond',
  'question.respond': 'question:respond',
} as const satisfies Record<string, RemoteCapability>

export type RemoteMethod = keyof typeof REMOTE_METHOD_CAPABILITIES

export function isRemoteMethod(method: string): method is RemoteMethod {
  return method in REMOTE_METHOD_CAPABILITIES
}

export function capabilityForRemoteMethod(method: RemoteMethod): RemoteCapability {
  return REMOTE_METHOD_CAPABILITIES[method]
}

export function principalCapabilities(principal: RemotePrincipal): Set<RemoteCapability> {
  const capabilities = new Set<RemoteCapability>()
  for (const role of principal.roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) capabilities.add(capability)
  }
  return capabilities
}

export function can(principal: RemotePrincipal, capability: RemoteCapability): boolean {
  return principalCapabilities(principal).has(capability)
}

export function authorize(principal: RemotePrincipal, capability: RemoteCapability): void {
  if (!can(principal, capability)) {
    throw new Error(`principal ${principal.userId}/${principal.deviceId} lacks capability ${capability}`)
  }
}

export function authorizeRemoteMethod(principal: RemotePrincipal, method: RemoteMethod): void {
  authorize(principal, capabilityForRemoteMethod(method))
}

/**
 * Methods that upstream pins to loopback. They must never be reachable
 * through the remote transport, regardless of role.
 */
export const FORBIDDEN_REMOTE_METHODS = new Set([
  'host.pickDirectory',
  'host.listDirectory',
  'host.createDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'llm.discoverModels',
])
