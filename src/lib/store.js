import { authRedirectUrl, supabase } from './supabase'
import { slugVariants } from './slug'
import { sanitizeCifraLines } from './cifraSanitize'
import { readCachedSong, writeCachedSong } from './songCache'
import { loadListToneMap, saveListTone } from './listTone'
import {
  readListCache,
  readListsCache,
  removeListCache,
  saveListCache,
  saveListsCache
} from './offline'

// getSession lê a sessão do aparelho (funciona offline), ao contrário de getUser,
// que valida no servidor. Usado apenas para escolher a chave do cache local.
async function currentUserId() {
  try {
    const { data } = await supabase.auth.getSession()
    return data?.session?.user?.id || null
  } catch {
    return null
  }
}

export async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (error) throw error
  return data
}

export async function checkUsername(username) {
  const { data, error } = await supabase.rpc('username_available', { p_username: username })
  if (error) throw error
  return data
}

// login aceita email ou username
export async function signInWithLogin(identifier, password) {
  let email = identifier
  if (!identifier.includes('@')) {
    const { data, error } = await supabase.rpc('get_email_for_username', { p_username: identifier })
    if (error) throw error
    if (!data) throw new Error('Usuário ou senha inválidos.')
    email = data
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error('Usuário ou senha inválidos.')
}

export async function signInWithGoogle(next) {
  const base = authRedirectUrl()
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : ''
  // Volta para a própria tela de login já com o destino, para não perder o link
  // quando o usuário precisa entrar antes de ver uma lista compartilhada.
  const redirectTo = safeNext
    ? `${base}#/auth?next=${encodeURIComponent(safeNext)}`
    : base
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: { prompt: 'select_account' }
    }
  })
  if (error) throw new Error(error.message || 'Não foi possível entrar com o Google.')
}

function usernameFromUser(user) {
  const meta = user?.user_metadata || {}
  const raw = String(meta.username || meta.preferred_username || meta.full_name || user?.email || 'user')
  const local = raw.includes('@') ? raw.split('@')[0] : raw
  let base = local.toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 18)
  if (base.length < 2) base = 'user'
  return base
}

export async function ensureProfile(user) {
  if (!user?.id) return null
  const { data: existing } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (existing) return existing
  let username = usernameFromUser(user)
  let n = 0
  while (n < 30) {
    const available = await checkUsername(username).catch(() => false)
    if (available) break
    n += 1
    username = `${usernameFromUser(user)}${n}`
  }
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id: user.id, email: user.email || '', username })
    .select('*')
    .maybeSingle()
  if (error) {
    const { data: again } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
    return again || null
  }
  return data
}

export async function signUpWithUsername(email, password, username) {
  const ok = await checkUsername(username)
  if (!ok) throw new Error('Este nome de usuário já está em uso.')
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } }
  })
  if (error) {
    if (/username|duplicate/i.test(error.message)) {
      throw new Error('Este nome de usuário já está em uso.')
    }
    throw new Error(error.message)
  }
  return data
}

// ------------------------- Catálogo de cifras -------------------------

export async function searchSongsLocal(q, limit = 30) {
  q = String(q || '').trim()
  if (!q) return []
  const tokens = q.replace(/[\\%_*(),]/g, ' ').split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  let query = supabase
    .from('songs')
    .select('id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root')
    .eq('version', 'original')
  if (tokens.length === 1) {
    const t = tokens[0]
    query = query.or(`artist.ilike.*${t}*,title.ilike.*${t}*`)
  } else {
    const parts = tokens.map((t) => `or(artist.ilike.*${t}*,title.ilike.*${t}*)`)
    query = query.or(`and(${parts.join(',')})`)
  }
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export async function getSongById(id) {
  if (!id) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const cached = readCachedSong(id)
    if (cached) return cached
  }
  try {
    const { data, error } = await supabase.from('songs').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    if (data) writeCachedSong(data)
    return data
  } catch (e) {
    const cached = readCachedSong(id)
    if (cached) return cached
    throw e
  }
}

export async function getSongBySlug(slugArtist, slugTitle, version = 'original') {
  const titles = slugVariants(slugTitle)
  const artists = slugVariants(slugArtist)
  let lastError = null
  for (const a of artists) {
    for (const t of titles) {
      const { data, error } = await supabase
        .from('songs')
        .select('*')
        .eq('slug_artist', a)
        .eq('slug_title', t)
        .eq('version', version)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (error) lastError = error
      if (data) {
        writeCachedSong(data)
        return data
      }
    }
  }
  if (lastError) throw lastError
  return null
}

const recentsKey = (userId) => `nevoa_recents_${userId || 'anon'}`

function readRecentIds(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(recentsKey(userId)) || '[]')
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function recordRecentSong(song, userId) {
  if (!song?.id || !userId) return
  const ids = readRecentIds(userId).filter((id) => id !== song.id)
  ids.unshift(song.id)
  try {
    localStorage.setItem(recentsKey(userId), JSON.stringify(ids.slice(0, 24)))
  } catch {}
}

export async function listRecentSongs(userId, limit = 12) {
  if (!userId) return []
  const ids = readRecentIds(userId).slice(0, limit)
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('songs')
    .select('id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root, version')
    .in('id', ids)
  if (error) throw error
  const byId = new Map((data || []).map((s) => [s.id, s]))
  return ids.map((id) => byId.get(id)).filter(Boolean)
}

export function parseSongContent(song) {
  let lines = song?.content
  if (typeof lines === 'string') {
    try {
      lines = JSON.parse(lines)
    } catch {
      lines = []
    }
  }
  return sanitizeCifraLines(Array.isArray(lines) ? lines : [])
}

// ------------------------- Listas -------------------------

export async function getLists() {
  const uid = await currentUserId()
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return []
    const { data, error } = await supabase
      .from('lists')
      .select('*, list_songs(count)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    const lists = (data || []).map((l) => ({ ...l, count: l.list_songs?.[0]?.count ?? 0 }))
    saveListsCache(uid, lists)
    return lists
  } catch (e) {
    const cached = readListsCache(uid)
    if (uid && cached.length) return cached
    throw e
  }
}

export async function createList(name) {
  const { data, error } = await supabase.from('lists').insert({ name }).select('*').single()
  if (error) throw error
  return data
}

export async function renameList(id, name) {
  const { error } = await supabase.from('lists').update({ name, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}

export async function deleteList(id) {
  const { error } = await supabase.from('lists').delete().eq('id', id)
  if (error) throw error
  const uid = await currentUserId()
  removeListCache(uid, id)
}

export async function getListWithSongs(id) {
  const uid = await currentUserId()
  try {
    const list = await fetchListWithSongs(id)
    if (list) saveListCache(uid, list)
    return list
  } catch (e) {
    const cached = readListCache(uid, id)
    if (uid && cached) return cached
    throw e
  }
}

async function fetchListWithSongs(id) {
  const { data: list, error: e1 } = await supabase
    .from('lists')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (e1) throw e1
  if (!list) return null
  if (list.shared_from_token) {
    // cópia seguidora: puxa as alterações do dono antes de exibir
    try {
      await syncFollowingList(list)
    } catch {
      // segue com o último conteúdo sincronizado se a origem estiver fora
    }
  }
  const withTone = await supabase
    .from('list_songs')
    .select(
      'id, position, shift, capo, songs(id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root)'
    )
    .eq('list_id', id)
    .order('position', { ascending: true })
  let items = withTone.data
  let e2 = withTone.error
  if (e2 && /column|schema cache|does not exist|PGRST204/i.test(`${e2.message || ''} ${e2.code || ''}`)) {
    const retry = await supabase
      .from('list_songs')
      .select(
        'id, position, songs(id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root)'
      )
      .eq('list_id', id)
      .order('position', { ascending: true })
    items = retry.data
    e2 = retry.error
  }
  if (e2) throw e2
  const tones = loadListToneMap(id)
  return {
    ...list,
    items: (items || []).map((it) => {
      const song = it.songs
      const local = song?.id ? tones[song.id] : null
      const shift = it.shift != null ? Number(it.shift) || 0 : Number(local?.shift) || 0
      const capo = it.capo != null ? Number(it.capo) || 0 : Number(local?.capo) || 0
      return { ...it, song, shift, capo }
    })
  }
}

function makeShareToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export async function shareList(id) {
  const { data, error } = await supabase
    .from('lists')
    .select('share_token')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  const token = data?.share_token || makeShareToken()
  const { error: e2 } = await supabase
    .from('lists')
    .update({ share_token: token, is_public: true, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (e2) throw e2
  return token
}

export async function unshareList(id) {
  const { error } = await supabase
    .from('lists')
    .update({ is_public: false, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// lê uma lista compartilhada (modo leitura). O tom exibido prioriza a
// preferência local do leitor (toneScope) sobre o tom salvo pelo dono.
export async function getSharedList(token, toneScope) {
  if (!token) return null
  const { data: list, error } = await supabase
    .from('lists')
    .select('id, name, share_token, is_public, created_at, updated_at')
    .eq('share_token', token)
    .eq('is_public', true)
    .maybeSingle()
  if (error) throw error
  if (!list) return null
  const { data, error: e2 } = await supabase
    .from('list_songs')
    .select(
      'id, position, shift, capo, songs(id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root, version)'
    )
    .eq('list_id', list.id)
    .order('position', { ascending: true })
  if (e2) throw e2
  const tones = toneScope ? loadListToneMap(toneScope) : {}
  const { id: _listId, ...meta } = list
  return {
    ...meta,
    items: (data || [])
      .map((it) => {
        const song = it.songs
        const local = song?.id ? tones[song.id] : null
        const shift = local ? Number(local.shift) || 0 : it.shift != null ? Number(it.shift) || 0 : 0
        const capo = local ? Number(local.capo) || 0 : it.capo != null ? Number(it.capo) || 0 : 0
        return { ...it, song, shift, capo }
      })
      .filter((it) => it.song)
  }
}

// Salva uma cópia da lista compartilhada na conta do leitor, marcada como
// somente-leitura: o dono da cópia não altera conteúdo (só o tom das cifras).
export async function saveSharedList(token, toneScope) {
  const shared = await getSharedList(token, toneScope)
  if (!shared) throw new Error('Este link não está mais disponível.')
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Entre para salvar a lista.')
  // já salvou esta mesma lista antes? reaproveita a cópia (e ela será
  // sincronizada ao abrir).
  const { data: existing } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', user.id)
    .eq('shared_from_token', token)
    .maybeSingle()
  if (existing?.id) return existing.id
  const baseName = String(shared.name || 'Lista compartilhada').trim().slice(0, 110)
  const { data: created, error } = await supabase
    .from('lists')
    .insert({
      name: `${baseName} (compartilhada)`,
      is_readonly: true,
      shared_from_token: token
    })
    .select('id')
    .single()
  if (error) throw error
  const rows = (shared.items || [])
    .filter((it) => it.song?.id)
    .map((it, idx) => ({
      list_id: created.id,
      song_id: it.song.id,
      position: it.position != null ? it.position : idx,
      shift: Number(it.shift) || 0,
      capo: Number(it.capo) || 0
    }))
  if (rows.length) {
    const { error: e2 } = await supabase.from('list_songs').insert(rows)
    if (e2) throw e2
  }
  return created.id
}

// Sincroniza uma cópia "seguidora" com a lista de origem: adiciona músicas
// novas, remove as excluídas e atualiza a ordem. Os ajustes de tom do leitor
// (shift/capo já salvos em list_songs) são preservados.
export async function syncFollowingList(list) {
  const token = list?.shared_from_token
  if (!token || !list?.id) return false
  const shared = await getSharedList(token)
  if (!shared) return false
  const sourceItems = (shared.items || []).filter((it) => it.song?.id)
  const { data: own, error } = await supabase
    .from('list_songs')
    .select('id, song_id')
    .eq('list_id', list.id)
  if (error) throw error
  const keep = new Set(sourceItems.map((it) => it.song.id))
  // upsert só atualiza a posição: shift/capo existentes permanecem intactos
  const rows = sourceItems.map((it, idx) => ({
    list_id: list.id,
    song_id: it.song.id,
    position: it.position != null ? it.position : idx
  }))
  if (rows.length) {
    const { error: e1 } = await supabase
      .from('list_songs')
      .upsert(rows, { onConflict: 'list_id,song_id' })
    if (e1) throw e1
  }
  const toRemove = (own || []).filter((r) => !keep.has(r.song_id)).map((r) => r.id)
  if (toRemove.length) {
    const { error: e2 } = await supabase.from('list_songs').delete().in('id', toRemove)
    if (e2) throw e2
  }
  return true
}

export async function updateListSongTone(listId, songId, tone) {
  const shift = Number(tone?.shift) || 0
  const capo = Number(tone?.capo) || 0
  saveListTone(listId, songId, { shift, capo })
  const { error } = await supabase
    .from('list_songs')
    .update({ shift, capo })
    .eq('list_id', listId)
    .eq('song_id', songId)
  if (error && error.code !== 'PGRST204' && !/column|schema cache/i.test(error.message || '')) {
    throw error
  }
}

export async function addSongToList(listId, songId) {
  const { data: last } = await supabase
    .from('list_songs')
    .select('position')
    .eq('list_id', listId)
    .order('position', { ascending: false })
    .limit(1)
  const position = (last?.[0]?.position ?? -1) + 1
  const { error } = await supabase
    .from('list_songs')
    .insert({ list_id: listId, song_id: songId, position })
  if (error) {
    if (error.code === '23505') return
    throw error
  }
}

export async function removeSongFromList(listSongId) {
  const { error } = await supabase.from('list_songs').delete().eq('id', listSongId)
  if (error) throw error
}

export async function moveListSong(listSongId, dir) {
  // reordenação simples: sobe/desce trocando posições
  const { data: cur } = await supabase
    .from('list_songs')
    .select('id, list_id, position')
    .eq('id', listSongId)
    .single()
  if (!cur) return
  const { data: other } = await supabase
    .from('list_songs')
    .select('id, position')
    .eq('list_id', cur.list_id)
    .eq('position', cur.position + dir)
    .maybeSingle()
  if (!other) return
  const { error } = await supabase.rpc('swap_list_positions', {
    p_a: cur.id,
    p_b: other.id
  })
  if (error) throw error
}

// ------------------------- Recados da lista (chat) -------------------------

const messagesKey = (token) => `nevoa_msgs_${token}`

function readMessagesCache(token) {
  try {
    const raw = JSON.parse(localStorage.getItem(messagesKey(token)) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function saveMessagesCache(token, rows) {
  try {
    localStorage.setItem(messagesKey(token), JSON.stringify(rows.slice(-120)))
  } catch {}
}

// Lê os recados do link compartilhado. Cai no cache local quando offline.
export async function listMessages(token) {
  if (!token) return []
  try {
    const { data, error } = await supabase
      .from('list_messages')
      .select('*')
      .eq('share_token', token)
      .order('created_at', { ascending: true })
      .limit(200)
    if (error) throw error
    saveMessagesCache(token, data || [])
    return data || []
  } catch (e) {
    const cached = readMessagesCache(token)
    if (cached.length) return cached
    throw e
  }
}

export async function sendListMessage({ token, body, songId, username }) {
  const text = String(body || '').trim()
  if (!token) throw new Error('A lista precisa de um link de compartilhamento.')
  if (!text) throw new Error('Escreva um recado.')
  const uid = await currentUserId()
  if (!uid) throw new Error('Entre para enviar recados.')
  const { data, error } = await supabase
    .from('list_messages')
    .insert({
      share_token: token,
      user_id: uid,
      username: String(username || 'Membro').slice(0, 40),
      body: text.slice(0, 2000),
      song_id: songId || null
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function deleteListMessage(id) {
  const { error } = await supabase.from('list_messages').delete().eq('id', id)
  if (error) throw error
}

// ------------------------- Favoritos -------------------------

export async function getFavorites() {
  const { data, error } = await supabase
    .from('favorites')
    .select('created_at, songs(id, artist, title, slug_artist, slug_title, youtube_url, image_url, tone_root)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map((f) => ({ created_at: f.created_at, song: f.songs }))
}

export async function toggleFavorite(songId) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Faça login para favoritar.')
  const { data: existing } = await supabase
    .from('favorites')
    .select('song_id')
    .eq('user_id', user.id)
    .eq('song_id', songId)
    .maybeSingle()
  if (existing) {
    const { error } = await supabase.from('favorites').delete().eq('user_id', user.id).eq('song_id', songId)
    if (error) throw error
    return false
  }
  const { error } = await supabase.from('favorites').insert({ user_id: user.id, song_id: songId })
  if (error) throw error
  return true
}

export async function isFavorite(songId) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data, error } = await supabase
    .from('favorites')
    .select('song_id')
    .eq('user_id', user.id)
    .eq('song_id', songId)
    .maybeSingle()
  if (error) return false
  return !!data
}
