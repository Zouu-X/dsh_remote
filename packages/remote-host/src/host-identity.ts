import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostId } from '@dsh-remote/protocol'

/**
 * Host identity is persisted on disk so the same Mac keeps the same Host ID
 * across restarts and future transport changes.
 */

export interface HostIdentityOptions {
  /** Path to the state file; default `~/.dsh-remote/host-state.json`. */
  stateFile?: string
}

export interface HostIdentity {
  hostId: HostId
  createdAt: string
  /** SPKI PEM public key for the host device key stored in Keychain. */
  devicePublicKey?: string
  /** SHA-256 fingerprint prefix of the device public key. */
  deviceKeyFingerprint?: string
}

export interface HostDeviceKeyRecord {
  publicKeyPem: string
  fingerprint: string
}

export function defaultHostStateFile(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return `${home}/.dsh-remote/host-state.json`
}

export function loadOrCreateHostIdentity(options: HostIdentityOptions = {}): HostIdentity {
  const stateFile = options.stateFile ?? defaultHostStateFile()
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<HostIdentity>
    if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
      return {
        hostId: parsed.hostId as HostId,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
        ...(typeof parsed.devicePublicKey === 'string' && { devicePublicKey: parsed.devicePublicKey }),
        ...(typeof parsed.deviceKeyFingerprint === 'string' && { deviceKeyFingerprint: parsed.deviceKeyFingerprint }),
      }
    }
  } catch {
    // Missing or corrupt state is replaced below.
  }

  const identity: HostIdentity = {
    hostId: `host_${randomUUID()}` as HostId,
    createdAt: new Date().toISOString(),
  }
  writeHostIdentity(stateFile, identity)
  return identity
}

/**
 * Persist the non-secret device public key/fingerprint into the existing host
 * state file. The private key remains only in Keychain.
 */
export function persistHostDeviceKey(
  stateFile: string,
  record: HostDeviceKeyRecord,
): HostIdentity {
  const identity = loadOrCreateHostIdentity({ stateFile })
  const updated: HostIdentity = {
    ...identity,
    devicePublicKey: record.publicKeyPem,
    deviceKeyFingerprint: record.fingerprint,
  }
  writeHostIdentity(stateFile, updated)
  return updated
}

function writeHostIdentity(stateFile: string, identity: HostIdentity): void {
  mkdirSync(dirname(stateFile), { recursive: true })
  const tempFile = `${stateFile}.tmp`
  writeFileSync(tempFile, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  renameSync(tempFile, stateFile)
}
