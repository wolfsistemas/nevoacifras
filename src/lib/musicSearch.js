function cleanTrack(name) {
  return String(name || '')
    .replace(/\s*\((?:live|ao vivo|acoustic|ac[uú]stico|remix|radio edit|oficial|espont[aâ]neo|playback)[^)]*\)/gi, '')
    .replace(/\s*\[(?:live|ao vivo|playback|oficial|espont[aâ]neo)[^\]]*\]/gi, '')
    .replace(/\s+\(feat\.?[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function hitKey(h) {
  const slugA = String(h.slug_artist || '').toLowerCase()
  const slugT = String(h.slug_title || '')
    .toLowerCase()
    .replace(/-+$/, '')
  if (slugA && slugT) return `s:${slugA}|${slugT}`
  return `n:${String(h.artist || '').toLowerCase()}|${String(h.title || '').toLowerCase()}`
}

function parseJsonp(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const start = raw.indexOf('(')
  const end = raw.lastIndexOf(')')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start + 1, end))
  } catch {
    return null
  }
}

function mapCifraDoc(d) {
  if (!d || String(d.t) !== '2') return null
  if (Number(d.block) === 1) return null
  const artist = String(d.art || '').trim()
  const title = String(d.txt || '').trim()
  const slug_artist = String(d.dns || '').trim()
  const slug_title = String(d.url || '').trim()
  if (!artist || !title || !slug_artist || !slug_title) return null
  return {
    artist,
    title,
    slug_artist,
    slug_title,
    image_url: d.imgm || null
  }
}

export async function searchCifraClub(q, limit = 10) {
  const query = String(q || '').trim()
  if (!query) return []
  const url = `https://solr.sscdn.co/cc/ac-mini?q=${encodeURIComponent(query)}`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = parseJsonp(await res.text())
  const docs = data?.response?.docs || []
  const out = []
  const seen = new Set()
  for (const d of docs) {
    const hit = mapCifraDoc(d)
    if (!hit) continue
    const key = hitKey(hit)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

export async function searchItunes(q, limit = 10) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}&country=BR`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  const rows = data.results || []
  const out = []
  const seen = new Set()
  for (const r of rows) {
    const artist = String(r.artistName || '').split(',')[0].trim()
    const title = cleanTrack(r.trackName)
    if (!artist || !title) continue
    const key = `${artist.toLowerCase()}|${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      artist,
      title,
      image_url: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : null
    })
  }
  return out
}

export async function resolveCifraHit(hit) {
  if (!hit) return null
  if (hit.slug_artist && hit.slug_title) return hit
  const artist = String(hit.artist || '').trim()
  const title = String(hit.title || '').trim()
  if (!artist || !title) return hit
  const queries = [`${artist} ${title}`, `${title} ${artist}`, title]
  const needleArtist = artist.toLowerCase()
  const needleTitle = title.toLowerCase()
  let best = null
  let bestScore = 59
  for (const q of queries) {
    let hits = []
    try {
      hits = await searchCifraClub(q, 12)
    } catch {
      continue
    }
    for (const cand of hits) {
      const ha = String(cand.artist || '').toLowerCase()
      const ht = String(cand.title || '').toLowerCase()
      const sa = String(cand.slug_artist || '').toLowerCase()
      let score = 0
      if (ht === needleTitle) score += 50
      else if (ht.startsWith(needleTitle) || needleTitle.startsWith(ht)) score += 20
      else continue
      if (ha === needleArtist || sa === needleArtist.replace(/\s+/g, '-')) score += 40
      const aliases = String(cand.artist).match(/\(([^)]+)\)/g) || []
      for (const raw of aliases) {
        const inner = raw.slice(1, -1).toLowerCase()
        if (inner === needleArtist || inner.includes(needleArtist) || needleArtist.includes(inner)) {
          score += 40
        }
      }
      if (ha.includes(needleArtist) || needleArtist.includes(ha)) score += 25
      if (score > bestScore) {
        bestScore = score
        best = cand
      }
    }
    if (best && bestScore >= 90) break
  }
  return best || hit
}

export async function searchRemoteSongs(q, limit = 10) {
  try {
    const cc = await searchCifraClub(q, limit)
    if (cc.length) return cc
  } catch {
    // fallback iTunes abaixo
  }
  try {
    const itunes = await searchItunes(q, limit)
    const resolved = await Promise.all(itunes.map((hit) => resolveCifraHit(hit)))
    const out = []
    const seen = new Set()
    for (const hit of resolved) {
      if (!hit?.slug_artist || !hit?.slug_title) continue
      const key = hitKey(hit)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

export function mergeHits(local, remote) {
  const out = []
  const seen = new Set()
  for (const h of [...(local || []), ...(remote || [])]) {
    const key = hitKey(h)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
    if (out.length >= 10) break
  }
  return out
}
