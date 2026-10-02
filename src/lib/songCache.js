const KEY = 'nevoa_song_cache'
const MAX = 120

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function writeCachedSong(song) {
  if (!song?.id) return
  try {
    const all = readAll()
    all[song.id] = { song, at: Date.now() }
    const ids = Object.keys(all)
    if (ids.length > MAX) {
      ids
        .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
        .slice(0, ids.length - MAX)
        .forEach((id) => {
          delete all[id]
        })
    }
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {}
}

export function readCachedSong(id) {
  if (!id) return null
  return readAll()[id]?.song || null
}
