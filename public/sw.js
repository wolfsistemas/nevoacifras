const SHELL = 'nevoa-shell-v3'
const API = 'nevoa-api-v3'
const MAX_API = 500
const PRECACHE = ['./', './index.html', './manifest.json', './logo.png', './favicon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).catch(() => null))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

async function trim(cache, max) {
  try {
    const keys = await cache.keys()
    if (keys.length <= max) return
    for (const key of keys.slice(0, keys.length - max)) await cache.delete(key)
  } catch {}
}

function isApi(url) {
  return url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const sameOrigin = url.origin === self.location.origin

  // Navegação: rede primeiro; sem rede, entrega o app shell do cache.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(async () => {
          const shell = await caches.open(SHELL)
          return (
            (await shell.match(req)) ||
            (await shell.match('./index.html')) ||
            (await shell.match('./')) ||
            Response.error()
          )
        })
    )
    return
  }

  // API do Supabase: rede primeiro; cache depois; sem nada, um 503 JSON
  // (evita devolver HTML para o supabase-js e quebrar o parse).
  if (isApi(url)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches
              .open(API)
              .then(async (c) => {
                await c.put(req, copy)
                trim(c, MAX_API)
              })
              .catch(() => {})
          }
          return res
        })
        .catch(async () => {
          const hit = await caches.match(req)
          if (hit) return hit
          return new Response(JSON.stringify({ message: 'offline', offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'X-Nevoa-Offline': '1' }
          })
        })
    )
    return
  }

  // Demais GET do mesmo domínio: cache primeiro, revalidando em segundo plano.
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone()
              caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {})
            }
            return res
          })
          .catch(() => cached || Response.error())
        return cached || network
      })
    )
  }
})
