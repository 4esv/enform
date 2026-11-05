// Issue #262, RT-3, RT-4, RT-5, I11, I15, I16, ADR 0007: the local-first
// store of the interface. Each edit of a draft is sealed with AES-256-GCM
// under a key that the session controls before it is stored, so the store
// holds ciphertext only. The key lives in the tab's session storage and
// never beside the ciphertext; sign-out and the idle timeout destroy both,
// so nothing is recoverable afterwards (I11). A stored draft reads back
// with its values and whether the server acknowledged it, so the interface
// shows "Saved on this device" or "Synced" (I15) and never an unconfirmed
// state as confirmed (I16). Operations that could not reach the server wait
// in a queue in the order they were made and flush in that order (RT-5).
// The storage and the secrets are injected: IndexedDB and sessionStorage in
// the browser, maps in a test.

/** The name under which the session storage holds the key (I11, ADR 0007). */
export const SESSION_KEY_NAME = 'enform.session.key'

/** The sync state of a held draft (I15). */
export type SyncState = 'saved' | 'synced'

/** A key-value store of strings: IndexedDB in the browser, a map in a test. */
export type KeyValueStore = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<readonly string[]>
  clear(): Promise<void>
}

/** A synchronous secret store: the tab's session storage, or a map in a test. */
export type SecretStore = {
  get(key: string): string | undefined | null
  set(key: string, value: string): void
  delete(key: string): void
}

/** One queued operation, as the page built it (I1). */
export type QueuedOperation = Record<string, unknown>

/** What a send attempt of a queued operation answered. */
export type SendOutcome = 'sent' | 'refused' | 'offline'

export type LocalStore = {
  /** Store the values of a draft under its id, sealed, with the state the interface shows (RT-3, I15). */
  readonly saveDraft: (
    id: string,
    values: Record<string, unknown>,
    state: SyncState
  ) => Promise<void>
  /** The values and the state of a draft, or undefined without the key or the draft. */
  readonly readDraft: (
    id: string
  ) => Promise<{ readonly values: Record<string, unknown>; readonly state: SyncState } | undefined>
  /** The server acknowledged the held edit (I15, I16). */
  readonly markSynced: (id: string) => Promise<void>
  /** Forget one draft (a deliberate discard, I15). */
  readonly forgetDraft: (id: string) => Promise<void>
  /** Remember which draft a flow's start page holds, so a refresh finds it (RT-4). */
  readonly rememberDraft: (flow: string, id: string) => Promise<void>
  readonly draftOf: (flow: string) => Promise<string | undefined>
  /** Queue an operation that must reach the server (RT-5). */
  readonly enqueue: (operation: QueuedOperation) => Promise<void>
  readonly pending: () => Promise<readonly QueuedOperation[]>
  /**
   * Send the queue in order. A sent operation leaves the queue; a refused
   * one leaves it and is reported, so the person sees the reason; the first
   * that does not reach the server stops the flush and stays queued.
   */
  readonly flush: (
    send: (operation: QueuedOperation) => Promise<SendOutcome>
  ) => Promise<{ sent: number; refused: readonly QueuedOperation[]; stopped: boolean }>
  /** Destroy the key and every stored value (I11). */
  readonly destroy: () => Promise<void>
}

const DRAFT_PREFIX = 'draft:'
const FLOW_PREFIX = 'flow:'
const QUEUE_KEY = 'queue'

/** An in-memory key-value store (tests, and a browser without IndexedDB). */
export function memoryStore(backing: Map<string, string> = new Map()): KeyValueStore {
  return {
    get: async (key) => backing.get(key),
    set: async (key, value) => {
      backing.set(key, value)
    },
    delete: async (key) => {
      backing.delete(key)
    },
    keys: async () => [...backing.keys()],
    clear: async () => backing.clear(),
  }
}

/** A secret store over a map (tests). */
export function memorySecrets(backing: Map<string, string> = new Map()): SecretStore {
  return {
    get: (key) => backing.get(key),
    set: (key, value) => {
      backing.set(key, value)
    },
    delete: (key) => {
      backing.delete(key)
    },
  }
}

const subtle = (): SubtleCrypto => {
  const api = globalThis.crypto?.subtle
  if (api === undefined) throw new Error('local: Web Crypto is not available (I11)')
  return api
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The session key: the one the secrets hold, else a new AES-256-GCM key stored there (ADR 0007). */
async function sessionKey(secrets: SecretStore): Promise<CryptoKey> {
  const held = secrets.get(SESSION_KEY_NAME)
  let raw: Uint8Array
  if (typeof held === 'string' && held !== '') {
    raw = fromBase64(held)
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32))
    secrets.set(SESSION_KEY_NAME, toBase64(raw))
  }
  return subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  )
  return `${toBase64(iv)}.${toBase64(new Uint8Array(body))}`
}

async function open(key: CryptoKey, sealed: string): Promise<string | undefined> {
  const [iv, body] = sealed.split('.')
  if (iv === undefined || body === undefined) return undefined
  try {
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) as BufferSource },
      key,
      fromBase64(body) as BufferSource
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return undefined
  }
}

/** Open the local store over a storage and a secret store. */
export async function openLocal(options: {
  readonly storage: KeyValueStore | Map<string, string>
  readonly secrets: SecretStore | Map<string, string>
}): Promise<LocalStore> {
  const storage = options.storage instanceof Map ? memoryStore(options.storage) : options.storage
  const secrets = options.secrets instanceof Map ? memorySecrets(options.secrets) : options.secrets
  const key = await sessionKey(secrets)

  const readQueue = async (): Promise<QueuedOperation[]> => {
    const raw = await storage.get(QUEUE_KEY)
    if (raw === undefined) return []
    const text = await open(key, raw)
    if (text === undefined) return []
    try {
      const parsed: unknown = JSON.parse(text)
      return Array.isArray(parsed) ? (parsed as QueuedOperation[]) : []
    } catch {
      return []
    }
  }
  const writeQueue = async (queue: readonly QueuedOperation[]): Promise<void> => {
    if (queue.length === 0) await storage.delete(QUEUE_KEY)
    else await storage.set(QUEUE_KEY, await seal(key, JSON.stringify(queue)))
  }

  const readDraft: LocalStore['readDraft'] = async (id) => {
    const raw = await storage.get(`${DRAFT_PREFIX}${id}`)
    if (raw === undefined) return undefined
    const text = await open(key, raw)
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text) as { values?: unknown; state?: unknown }
      if (typeof parsed.values !== 'object' || parsed.values === null) return undefined
      const state: SyncState = parsed.state === 'synced' ? 'synced' : 'saved'
      return { values: parsed.values as Record<string, unknown>, state }
    } catch {
      return undefined
    }
  }

  const saveDraft: LocalStore['saveDraft'] = async (id, values, state) => {
    await storage.set(`${DRAFT_PREFIX}${id}`, await seal(key, JSON.stringify({ values, state })))
  }

  return {
    saveDraft,
    readDraft,
    markSynced: async (id) => {
      const held = await readDraft(id)
      if (held !== undefined) await saveDraft(id, held.values, 'synced')
    },
    forgetDraft: async (id) => {
      await storage.delete(`${DRAFT_PREFIX}${id}`)
    },
    rememberDraft: async (flow, id) => {
      await storage.set(`${FLOW_PREFIX}${flow}`, await seal(key, id))
    },
    draftOf: async (flow) => {
      const raw = await storage.get(`${FLOW_PREFIX}${flow}`)
      return raw === undefined ? undefined : open(key, raw)
    },
    enqueue: async (operation) => {
      await writeQueue([...(await readQueue()), operation])
    },
    pending: readQueue,
    flush: async (send) => {
      const queue = await readQueue()
      const refused: QueuedOperation[] = []
      let sent = 0
      let index = 0
      while (index < queue.length) {
        const outcome = await send(queue[index])
        if (outcome === 'offline') {
          await writeQueue(queue.slice(index))
          return { sent, refused, stopped: true }
        }
        if (outcome === 'sent') sent += 1
        else refused.push(queue[index])
        index += 1
        await writeQueue(queue.slice(index))
      }
      return { sent, refused, stopped: false }
    },
    destroy: async () => {
      secrets.delete(SESSION_KEY_NAME)
      await storage.clear()
    },
  }
}

/** The IndexedDB-backed store of the browser (ADR 0007): one object store of sealed strings. */
export function indexedDbStore(name = 'enform-local'): KeyValueStore {
  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('values')) {
          request.result.createObjectStore('values')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('local: IndexedDB did not open'))
    })
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await openDb()
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = action(db.transaction('values', mode).objectStore('values'))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('local: the request failed'))
      })
    } finally {
      db.close()
    }
  }
  return {
    get: async (key) => {
      const value = await run<unknown>('readonly', (store) => store.get(key))
      return typeof value === 'string' ? value : undefined
    },
    set: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key))
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key))
    },
    keys: async () => {
      const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
      return keys.map((key) => String(key))
    },
    clear: async () => {
      await run('readwrite', (store) => store.clear())
    },
  }
}

/** The tab's session storage as a secret store (ADR 0007): the key never outlives the tab. */
export function sessionSecrets(): SecretStore {
  return {
    get: (key) => sessionStorage.getItem(key),
    set: (key, value) => sessionStorage.setItem(key, value),
    delete: (key) => sessionStorage.removeItem(key),
  }
}
