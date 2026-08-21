import { parseArgs } from 'node:util'
import { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import { CaffeinateSupervisor } from './caffeinate.js'
import { ensureHostDeviceKey } from './host-device-key.js'
import { JsonLogger } from './logger.js'
import { defaultHostStateFile, loadOrCreateHostIdentity, persistHostDeviceKey } from './host-identity.js'
import { MacKeychainSecretStore } from './keychain.js'
import { RemoteHostServer } from './server.js'
import { TailscaleCliIdentityProvider } from './tailscale-identity.js'

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`)
  }
  return port
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'harness-url': { type: 'string' },
    'state-file': { type: 'string' },
    'static-dir': { type: 'string' },
    'user-id': { type: 'string' },
    'device-id': { type: 'string' },
    caffeinate: { type: 'string' },
    'identity-provider': { type: 'string' },
    'allowed-device-ids': { type: 'string' },
    'secret-store': { type: 'string' },
  },
  allowPositionals: false,
})

const logger = new JsonLogger()
const stateFile = values['state-file'] ?? process.env.DSH_REMOTE_STATE_FILE ?? defaultHostStateFile()
const identity = loadOrCreateHostIdentity({ stateFile })
const harnessUrl = values['harness-url'] ?? process.env.DSH_REMOTE_HARNESS_URL ?? 'http://127.0.0.1:3080'
const staticDir = values['static-dir'] ?? process.env.DSH_REMOTE_STATIC_DIR
const adapter = new DeepSeekHarnessAdapter({
  baseUrl: harnessUrl,
  hostId: identity.hostId,
})
const port = values.port ?? process.env.DSH_REMOTE_PORT
const userId = values['user-id'] ?? process.env.DSH_REMOTE_USER_ID
const deviceId = values['device-id'] ?? process.env.DSH_REMOTE_DEVICE_ID
const caffeinateMode = values.caffeinate ?? process.env.DSH_REMOTE_CAFFEINATE ?? 'off'
if (!['off', 'auto'].includes(caffeinateMode)) {
  throw new Error(`invalid caffeinate mode: ${caffeinateMode} (expected off|auto)`)
}
const caffeinate = caffeinateMode === 'auto'
  ? new CaffeinateSupervisor({ adapter, logger })
  : undefined
const identityMode = values['identity-provider'] ?? process.env.DSH_REMOTE_IDENTITY_PROVIDER ?? 'tailscale'
if (!['tailscale', 'none'].includes(identityMode)) {
  throw new Error(`invalid identity provider: ${identityMode} (expected tailscale|none)`)
}
const identityProvider = identityMode === 'tailscale'
  ? new TailscaleCliIdentityProvider({ logger })
  : undefined
const allowedDeviceIds = (values['allowed-device-ids'] ?? process.env.DSH_REMOTE_ALLOWED_DEVICE_IDS)
  ?.split(',')
  .map(value => value.trim())
  .filter(value => value.length > 0)
const secretStoreMode = values['secret-store'] ?? process.env.DSH_REMOTE_SECRET_STORE ?? 'mac-keychain'
if (!['mac-keychain', 'none'].includes(secretStoreMode)) {
  throw new Error(`invalid secret store: ${secretStoreMode} (expected mac-keychain|none)`)
}
const secretStore = secretStoreMode === 'mac-keychain'
  ? new MacKeychainSecretStore({ logger })
  : undefined
const deviceKey = secretStore !== undefined
  ? await (async () => {
      try {
        const key = await ensureHostDeviceKey(secretStore, identity.hostId)
        persistHostDeviceKey(stateFile, {
          publicKeyPem: key.publicKeyPem,
          fingerprint: key.fingerprint,
        })
        return key
      } catch (error) {
        logger.warn({ error: String(error) }, 'device key provisioning failed; continuing without device key')
        return undefined
      }
    })()
  : undefined
const server = new RemoteHostServer({
  hostId: identity.hostId,
  adapter,
  logger,
  host: values.host ?? '127.0.0.1',
  port: port !== undefined ? parsePort(port) : 3090,
  ...(staticDir !== undefined && { staticDir }),
  ...(userId !== undefined && { userId }),
  ...(deviceId !== undefined && { deviceId }),
  ...(caffeinate !== undefined && { caffeinate }),
  ...(identityProvider !== undefined && { identityProvider }),
  ...(allowedDeviceIds !== undefined && allowedDeviceIds.length > 0 && { allowedDeviceIds }),
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({}, 'shutting down remote host')
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

try {
  await server.start()
  logger.info({
    harnessUrl,
    hostId: identity.hostId,
    ...(deviceKey !== undefined && {
      deviceKeyFingerprint: deviceKey.fingerprint,
      deviceKeyCreated: deviceKey.created,
      deviceKeyPersisted: true,
    }),
  }, 'dsh-remote-host ready')
} catch (error) {
  logger.error({ error: String(error) }, 'failed to start remote host')
  process.exit(1)
}
