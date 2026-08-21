import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function decodeKeychainPassword(raw: string): string {
  // `security find-generic-password -w` returns binary-safe data as hex.
  // Secrets written by this class are wrapped as base64:<data>.
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const decoded = Buffer.from(raw, 'hex').toString('utf8')
    if (decoded.startsWith('base64:')) return Buffer.from(decoded.slice(7), 'base64').toString('utf8')
    // Legacy value written as a raw PEM before the base64 wrapper.
    if (decoded.includes('BEGIN')) return decoded
  }
  if (raw.startsWith('base64:')) return Buffer.from(raw.slice(7), 'base64').toString('utf8')
  return raw
}

export interface SecretStore {
  setSecret(account: string, secret: string): Promise<void>
  getSecret(account: string): Promise<string | undefined>
  deleteSecret(account: string): Promise<void>
}

export interface MacKeychainSecretStoreOptions {
  service?: string
  command?: string
  execFile?: typeof execFileAsync
  logger?: { warn(fields: Record<string, unknown>, message: string): void }
}

/**
 * macOS Keychain wrapper. Secrets are passed through the `security` CLI and
 * are never logged by this class. Consumers must never put returned secrets
 * into log fields or repository files.
 */
export class MacKeychainSecretStore implements SecretStore {
  private readonly service: string
  private readonly command: string
  private readonly exec: typeof execFileAsync
  private readonly logger?: MacKeychainSecretStoreOptions['logger']

  constructor(options: MacKeychainSecretStoreOptions = {}) {
    this.service = options.service ?? 'com.dshbox.remote-host'
    this.command = options.command ?? '/usr/bin/security'
    this.exec = options.execFile ?? execFileAsync
    this.logger = options.logger
  }

  async setSecret(account: string, secret: string): Promise<void> {
    const encoded = `base64:${Buffer.from(secret, 'utf8').toString('base64')}`
    try {
      await this.exec(this.command, [
        'add-generic-password',
        '-a', account,
        '-s', this.service,
        '-U',
        '-w', encoded,
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
    } catch {
      // Deliberately discard the original error: execFile error messages can
      // contain the full command line including the secret.
      this.logger?.warn({ account }, 'keychain write failed')
      throw new Error('macOS Keychain write failed')
    }
  }

  async getSecret(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec(this.command, [
        'find-generic-password',
        '-a', account,
        '-s', this.service,
        '-w',
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
      const secret = decodeKeychainPassword(stdout.replace(/\r?\n$/, ''))
      return secret === '' ? undefined : secret
    } catch (error) {
      this.logger?.warn({ account }, 'keychain read failed or item not found')
      return undefined
    }
  }

  async deleteSecret(account: string): Promise<void> {
    try {
      await this.exec(this.command, [
        'delete-generic-password',
        '-a', account,
        '-s', this.service,
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 })
    } catch {
      this.logger?.warn({ account }, 'keychain delete failed or item already absent')
    }
  }
}
