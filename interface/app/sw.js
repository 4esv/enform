// Issue #262, RT-4, S07, ADR 0009: the service worker of the interface. It
// keeps the app shell (the page, its modules, the generated client) and the
// GET reads the pages need to render (the session, a flow, an instance) in a
// cache, so a refresh without a connection shows the local state at once:
// the shell comes from the cache and the page restores the draft from the
// device's sealed copy. Writes never go through the cache: a POST reaches
// the server or fails, and the page's queue keeps it. Reads prefer the
// network and fall back to the cache, so a page online shows the server's
// state and a page offline shows the last one it saw, marked as such by the
// transport mode (A4).

const CACHE = 'enform-shell-v1'

/** Whether a request is one the worker serves from the cache when offline. */
function cacheable(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/v1/')) {
    return (
      url.pathname === '/api/v1/session' ||
      url.pathname.startsWith('/api/v1/flows/') ||
      url.pathname.startsWith('/api/v1/instances/')
    )
  }
  // The shell: the page and every module under /app/ and /client/, and the
  // worker itself. The realtime stream and the log are never cached.
  return true
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** The cache key of a request: the API read as it is, the shell by its path alone. */
function keyOf(url) {
  return url.pathname.startsWith('/api/v1/') ? url.href : url.origin + url.pathname
}

// The page names the resources it loaded before the worker controlled it
// (the document, its modules, the reads it rendered from), so the first
// refresh without a connection already finds them (RT-4). The page waits for
// the answer before it says it is available offline.
self.addEventListener('message', (event) => {
  const data = event.data
  if (typeof data !== 'object' || data === null || data.type !== 'cache') return
  const urls = Array.isArray(data.urls) ? data.urls : []
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      for (const entry of urls) {
        let url
        try {
          url = new URL(String(entry), self.location.origin)
        } catch {
          continue
        }
        const request = new Request(url.href, { credentials: 'include' })
        if (!cacheable(request)) continue
        try {
          const response = await fetch(request)
          if (response.ok) await cache.put(keyOf(url), response.clone())
        } catch {
          // Offline already: the cache keeps what it has.
        }
      }
      event.source?.postMessage({ type: 'cached' })
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (!cacheable(request)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      // The page URL carries the flow and the instance in its query; the
      // shell is one document, so the cached entry is keyed by path alone.
      const key = keyOf(new URL(request.url))
      try {
        const response = await fetch(request)
        if (response.ok) await cache.put(key, response.clone())
        return response
      } catch (error) {
        const cached = await cache.match(key)
        if (cached !== undefined) return cached
        throw error
      }
    })()
  )
})
