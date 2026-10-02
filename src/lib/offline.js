// Cache local (por usuário) das listas salvas, para uso offline.
// Guarda apenas metadados e a estrutura das listas — nunca a cifra inteira —
// para não pesar no armazenamento do aparelho.
const PREFIX = 'nevoa_offline_v1'

function key(uid, suffix) {
  return `${PREFIX}:${uid}:${suffix}`
}

function readJson(k, fallback) {
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return fallback
    const val = JSON.parse(raw)
    return val ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(k, val) {
  try {
    localStorage.setItem(k, JSON.stringify(val))
  } catch {}
}

function slimSong(song) {
  if (!song) return null
  return {
    id: song.id,
    artist: song.artist,
    title: song.title,
    slug_artist: song.slug_artist,
    slug_title: song.slug_title,
    youtube_url: song.youtube_url,
    image_url: song.image_url,
    tone_root: song.tone_root,
    version: song.version
  }
}

export function saveListsCache(uid, lists) {
  if (!uid || !Array.isArray(lists)) return
  writeJson(
    key(uid, 'lists'),
    lists.map((l) => ({
      id: l.id,
      name: l.name,
      is_readonly: !!l.is_readonly,
      count: l.count ?? 0,
      created_at: l.created_at || null,
      updated_at: l.updated_at || null,
      shared_from_token: l.shared_from_token || null
    }))
  )
}

export function readListsCache(uid) {
  if (!uid) return []
  const cached = readJson(key(uid, 'lists'), [])
  return Array.isArray(cached) ? cached : []
}

export function saveListCache(uid, list) {
  if (!uid || !list?.id) return
  writeJson(key(uid, `list:${list.id}`), {
    id: list.id,
    name: list.name,
    is_readonly: !!list.is_readonly,
    shared_from_token: list.shared_from_token || null,
    items: (list.items || []).map((it) => ({
      id: it.id,
      position: it.position,
      shift: it.shift,
      capo: it.capo,
      song: slimSong(it.song)
    }))
  })
}

export function readListCache(uid, listId) {
  if (!uid || !listId) return null
  return readJson(key(uid, `list:${listId}`), null)
}

export function removeListCache(uid, listId) {
  if (!uid || !listId) return
  try {
    localStorage.removeItem(key(uid, `list:${listId}`))
  } catch {}
}
