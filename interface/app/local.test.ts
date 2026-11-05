import { expect, test } from 'vitest'

// Issue #262, RT-3, RT-4, RT-5, I11, I15, I16, ADR 0007: the local-first
// store of the interface. An edit is sealed under a session key before it
// is stored, so the store holds ciphertext only; the key lives in the
// session storage of the tab and never beside the ciphertext. A stored
// draft reads back with its values and its sync state, so a refresh shows
// the local state at once. Operations that could not reach the server wait
// in a queue in the order they were made, and the queue flushes in that
// order, stopping at the first that fails. Sign-out and the idle timeout
// destroy the key and the ciphertext together, so nothing is recoverable.
// The storage and the secrets are injected, so the checks run in Node.

type Values = Record<string, unknown>

type Local = {
  openLocal: (options: {
    storage: Map<string, string>
    secrets: Map<string, string>
    now?: () => number
  }) => Promise<{
    saveDraft: (id: string, values: Values, state: 'saved' | 'synced') => Promise<void>
    readDraft: (id: string) => Promise<{ values: Values; state: 'saved' | 'synced' } | undefined>
    markSynced: (id: string) => Promise<void>
    rememberDraft: (flow: string, id: string) => Promise<void>
    draftOf: (flow: string) => Promise<string | undefined>
    enqueue: (operation: Record<string, unknown>) => Promise<void>
    pending: () => Promise<readonly Record<string, unknown>[]>
    flush: (
      send: (operation: Record<string, unknown>) => Promise<'sent' | 'refused' | 'offline'>
    ) => Promise<{
      sent: number
      refused: readonly Record<string, unknown>[]
      stopped: boolean
    }>
    destroy: () => Promise<void>
  }>
  SESSION_KEY_NAME: string
}

const LOCAL_MODULE = new URL('./local.js', import.meta.url).href

async function local(): Promise<Local> {
  return (await import(LOCAL_MODULE)) as unknown as Local
}

test('#262 I11 a draft is stored as ciphertext under the session key and reads back with its state', async () => {
  const { openLocal, SESSION_KEY_NAME } = await local()
  const storage = new Map<string, string>()
  const secrets = new Map<string, string>()
  const store = await openLocal({ storage, secrets })
  await store.saveDraft('inst-1', { summary: 'three credits', credits: 3 }, 'saved')
  // The key is in the session secrets, not in the storage; the storage holds
  // no plaintext of the values (I11).
  expect(secrets.get(SESSION_KEY_NAME)).toBeTruthy()
  const stored = [...storage.values()].join('\n')
  expect(stored).not.toContain('three credits')
  expect(stored).not.toContain(secrets.get(SESSION_KEY_NAME))
  expect(await store.readDraft('inst-1')).toEqual({
    values: { summary: 'three credits', credits: 3 },
    state: 'saved',
  })
  // The server acknowledged the edit: Synced (I15, I16).
  await store.markSynced('inst-1')
  expect((await store.readDraft('inst-1'))?.state).toBe('synced')
  // A new edit is saved again, not synced yet.
  await store.saveDraft('inst-1', { summary: 'four credits', credits: 4 }, 'saved')
  expect((await store.readDraft('inst-1'))?.state).toBe('saved')
  // The draft of a flow is remembered, so the start page finds it after a refresh (RT-4).
  await store.rememberDraft('course-overload', 'inst-1')
  expect(await store.draftOf('course-overload')).toBe('inst-1')

  // A second session over the same storage, with the same key, reads the draft (RT-4).
  const again = await openLocal({ storage, secrets })
  expect((await again.readDraft('inst-1'))?.values).toEqual({ summary: 'four credits', credits: 4 })
  // A session without the key reads nothing: the ciphertext is unrecoverable (I11).
  const stranger = await openLocal({ storage, secrets: new Map() })
  expect(await stranger.readDraft('inst-1')).toBeUndefined()
})

test('#262 RT-5 queued operations flush in order and stop at the first that does not reach the server', async () => {
  const { openLocal } = await local()
  const storage = new Map<string, string>()
  const secrets = new Map<string, string>()
  const store = await openLocal({ storage, secrets })
  await store.enqueue({ id: 'op-1', type: 'instance.started@1' })
  await store.enqueue({ id: 'op-2', type: 'draft.edited@1' })
  await store.enqueue({ id: 'op-3', type: 'instance.submitted@1' })
  expect((await store.pending()).map((operation) => operation.id)).toEqual(['op-1', 'op-2', 'op-3'])
  // The queue survives a refresh: a new session over the same storage with
  // the same key, as the tab keeps it (I15, RT-4).
  const again = await openLocal({ storage, secrets })
  const sent: string[] = []
  const first = await again.flush(async (operation) => {
    sent.push(String(operation.id))
    return operation.id === 'op-2' ? 'offline' : 'sent'
  })
  expect(sent).toEqual(['op-1', 'op-2'])
  expect(first).toEqual({ sent: 1, refused: [], stopped: true })
  expect((await again.pending()).map((operation) => operation.id)).toEqual(['op-2', 'op-3'])
  // Back online: the rest goes; a refused operation leaves the queue and is
  // reported, so the person sees the reason and the draft stays (RT-5).
  const second = await again.flush(async (operation) =>
    operation.id === 'op-3' ? 'refused' : 'sent'
  )
  expect(second.sent).toBe(1)
  expect(second.refused.map((operation) => operation.id)).toEqual(['op-3'])
  expect(second.stopped).toBe(false)
  expect(await again.pending()).toEqual([])
})

test('#262 I11 destroy removes the key and every ciphertext, so nothing is recoverable', async () => {
  const { openLocal, SESSION_KEY_NAME } = await local()
  const storage = new Map<string, string>()
  const secrets = new Map<string, string>()
  const store = await openLocal({ storage, secrets })
  await store.saveDraft('inst-1', { summary: 'secret' }, 'saved')
  await store.enqueue({ id: 'op-1', type: 'draft.edited@1' })
  await store.destroy()
  expect(secrets.has(SESSION_KEY_NAME)).toBe(false)
  expect(storage.size).toBe(0)
  const after = await openLocal({ storage, secrets })
  expect(await after.readDraft('inst-1')).toBeUndefined()
  expect(await after.pending()).toEqual([])
})
