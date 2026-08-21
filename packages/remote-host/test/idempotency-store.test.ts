import { describe, expect, it } from 'vitest'
import { IdempotencyStore } from '../src/idempotency-store.js'

describe('IdempotencyStore', () => {
  it('replays stored successful results for duplicate keys', () => {
    let now = 1_000_000
    const store = new IdempotencyStore({ ttlMs: 1000, now: () => now })
    const result = { ok: true, value: { accepted: true } } as const

    expect(store.get('key_1')).toBeUndefined()
    store.set('key_1', result)
    expect(store.get('key_1')).toEqual(result)
  })

  it('expires entries after the ttl', () => {
    let now = 0
    const store = new IdempotencyStore({ ttlMs: 10, now: () => now })
    store.set('key_1', { ok: true, value: {} })
    now = 11
    expect(store.get('key_1')).toBeUndefined()
  })

  it('does not store failures implicitly', () => {
    const store = new IdempotencyStore()
    expect(store.get('missing')).toBeUndefined()
  })
})
