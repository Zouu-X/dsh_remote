import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import type { HostId } from '@dsh-remote/protocol'
import type { SecretStore } from './keychain.js'

export interface HostDeviceKeyProvision {
  publicKeyPem: string
  fingerprint: string
  created: boolean
}

/**
 * Provisions or loads the Mac host's long-lived device key pair.
 *
 * The private key lives only in the macOS Keychain. The public key and
 * fingerprint are non-secret and can be logged or written to the host state
 * file for B pairing.
 */
export async function ensureHostDeviceKey(store: SecretStore, hostId: HostId): Promise<HostDeviceKeyProvision> {
  const account = deviceKeyAccount(hostId)
  const existing = await store.getSecret(account)
  if (existing !== undefined) {
    const publicKey = derivePublicKey(existing)
    if (publicKey !== undefined) {
      return { publicKeyPem: publicKey, fingerprint: fingerprint(publicKey), created: false }
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await store.setSecret(account, privateKeyPem)
  return { publicKeyPem, fingerprint: fingerprint(publicKeyPem), created: true }
}

export function deviceKeyAccount(hostId: HostId): string {
  return `host-device-key:${hostId}`
}

export function fingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

function derivePublicKey(privateKeyPem: string): string | undefined {
  try {
    const privateKey = createPrivateKey(privateKeyPem)
    const publicKey = createPublicKey(privateKey)
    return publicKey.export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return undefined
  }
}
