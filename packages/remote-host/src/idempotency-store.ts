import type { RemoteRpcResponse } from '@dsh-remote/protocol'

export interface IdempotencyStoreOptions {
  ttlMs?: number
  now?: () => number
}

interface Entry {
  result: RemoteRpcResponse['result']
  expiresAt: number
}

/**
 * In-memory duplicate guard for remote write RPCs. The guard is process-local;
 * a future relay deployment can move the same key/value shape to the server.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: IdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  get(key: string): RemoteRpcResponse['result'] | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.result
  }

  set(key: string, result: RemoteRpcResponse['result']): void {
    this.prune()
    this.entries.set(key, {
      result,
      expiresAt: this.now() + this.ttlMs,
    })
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}
