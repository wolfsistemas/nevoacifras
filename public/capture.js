// Névoa Captura — roda no console ou via bookmarklet numa página de cifra do Cifra Club.
// Captura a cifra aberta, converte para o formato do app e grava na sua conta Supabase.
(function () {
  const SUPA_URL = 'https://luguppodlfqnnmnwooar.supabase.co'
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1Z3VwcG9kbGZxbm5tbndvb2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MzE5NDAsImV4cCI6MjEwNDAwNzk0MH0.C-rR3YiFPqZcqOhB_JGis6nrtrcWWe6rnQXnYkKdxNw'
  const TOKEN = 'nevoa-cap-f75e76f08aa098e062343201'
  const KEY = 'nevoa_captures_v1'

  // ---------------- parser (mesmo do app) ----------------
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  function unescapeHtml(s) {
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ENTITIES[n.toLowerCase()] || '')
  }
  function looksLikeTabLine(text) {
    const t = String(text || '').trim()
    if (!t) return false
    if (/^\[?\s*tab\b/i.test(t)) return true
    if (/^[eEBGDA]\s*[|:].*[-0-9]/.test(t)) return true
    if (/^[a-gA-G]\|[-0-9hpbrx/\\~+| ]+$/.test(t)) return true
    const bars = (t.match(/\|/g) || []).length
    const leftover = t.replace(/[-0-9|hpbrx/\\~:\s()+]/gi, '')
    return bars >= 2 && /-{3,}/.test(t) && leftover.length <= 2
  }
  function stripExceptBold(html) {
    return String(html || '')
      .replace(/<div[^>]*class="[^"]*tabs?[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '\n')
      .replace(/<(?:span|div)[^>]*class="[^"]*tab[^"]*"[^>]*>[\s\S]*?<\/(?:span|div)>/gi, '\n')
      .replace(/<(?!\/?b\b)[^>]+>/gi, (tag) => (/^<br/i.test(tag) ? '\n' : ''))
  }
  function scanTokens(blockHtml) {
    const tokens = []
    const cleaned = stripExceptBold(blockHtml)
    const tagRe = /<b\b([^>]*)>([\s\S]*?)<\/b>/gi
    let last = 0
    let m
    while ((m = tagRe.exec(cleaned))) {
      if (m.index > last) tokens.push({ type: 'text', s: unescapeHtml(cleaned.slice(last, m.index)) })
      const attrs = m[1]
      const visible = unescapeHtml(m[2].replace(/<[^>]+>/g, ''))
      const attrName = (attrs.match(/data-chord-name="([^"]*)"/) || [])[1]
      tokens.push({ type: 'chord', name: attrName || visible, text: visible })
      last = tagRe.lastIndex
    }
    if (last < cleaned.length) tokens.push({ type: 'text', s: unescapeHtml(cleaned.slice(last)) })
    return tokens
  }
  function tokensToRows(tokens) {
    const rows = []
    let parts = []
    let chords = []
    let col = 0
    const flush = () => {
      rows.push({ chords: chords, text: parts.join('') })
      parts = []
      chords = []
      col = 0
    }
    for (const tok of tokens) {
      if (tok.type === 'text') {
        for (const ch of tok.s) {
          if (ch === '\n') flush()
          else {
            parts.push(ch)
            col++
          }
        }
      } else {
        chords.push({ name: tok.name, col })
        for (const ch of tok.text) {
          parts.push(ch)
          col++
        }
      }
    }
    if (parts.length || chords.length) flush()
    return rows
  }
  function tokenizeWords(lineText) {
    const words = []
    let i = 0
    while (i < lineText.length) {
      while (i < lineText.length && lineText[i] === ' ') i++
      const start = i
      while (i < lineText.length && lineText[i] !== ' ') i++
      if (i > start) words.push({ w: lineText.slice(start, i), col: start })
    }
    return words
  }
  function mapChordsToWords(words, chordList) {
    const chordAt = []
    for (const c of chordList) {
      let target = words.findIndex((wd) => wd.col >= c.col)
      if (target === -1) target = words.length - 1
      if (target < 0) continue
      const existing = chordAt.find((x) => x.wi === target)
      if (existing) existing.names.push(c.name)
      else chordAt.push({ wi: target, names: [c.name] })
    }
    return chordAt.sort((a, b) => a.wi - b.wi)
  }
  function parseCifraHtml(html) {
    const preMatch = html.match(/<pre[^>]*data-chord-content="true"[^>]*>([\s\S]*?)<\/pre>/i)
    const rows = []
    if (preMatch) {
      const preInner = preMatch[1].replace(/<div[^>]*class="[^"]*tabs?[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '\n[Tab]\n')
      const blockRe = /<div class="kvMV">([\s\S]*?)<\/div>/gi
      let m
      while ((m = blockRe.exec(preInner))) rows.push(...tokensToRows(scanTokens(m[1])))
    } else {
      const oldMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
      if (!oldMatch) throw new Error('Conteúdo da cifra não encontrado na página.')
      const inner = oldMatch[1].replace(/<span[^>]*class="[^"]*tablatura[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '\n[Tab]\n')
      rows.push(...tokensToRows(scanTokens(inner)))
    }
    const lines = []
    let tuning = null
    let toneRoot = null
    let inTab = false
    const pushPlain = (raw) => {
      const text = raw.replace(/\s+$/, '')
      if (text.trim() === '') {
        lines.push({ kind: 'blank' })
        return
      }
      const t = text.trim()
      if (/^\[?\s*tab\b/i.test(t) || looksLikeTabLine(t)) {
        inTab = /^\[?\s*tab\b/i.test(t) ? true : inTab
        lines.push({ kind: 'tab', text: t })
        if (/^\[/.test(t) && !/^\[?\s*tab\b/i.test(t)) inTab = false
        return
      }
      if (t.startsWith('[') && !/^\[?\s*tab\b/i.test(t)) {
        inTab = false
        lines.push({ kind: 'label', text: t })
        return
      }
      if (inTab) {
        lines.push({ kind: 'tab', text: t })
        return
      }
      const af = t.match(/^afinação\s*:?\s*(.*)$/i)
      if (af) {
        tuning = af[1].trim()
        lines.push({ kind: 'tuning', text: 'Afinação: ' + tuning })
        return
      }
      lines.push({ kind: 'text', text: t })
    }
    let i = 0
    while (i < rows.length) {
      const row = rows[i]
      const text = row.text
      if (looksLikeTabLine(text) || inTab) {
        pushPlain(text)
        i += 1
        continue
      }
      if (row.chords.length) {
        const next = rows[i + 1]
        const hasLyricNext =
          next &&
          next.chords.length === 0 &&
          next.text.replace(/\s+$/, '') !== '' &&
          !next.text.trim().startsWith('[') &&
          !looksLikeTabLine(next.text)
        if (hasLyricNext) {
          const lyricText = next.text.replace(/\s+$/, '')
          const words = tokenizeWords(lyricText)
          const chordAt = mapChordsToWords(words, row.chords)
          for (const c of row.chords) {
            const idx = (c.name.match(/^[A-Ga-g][#b]?/) || [])[0]
            if (idx) toneRoot = idx
          }
          lines.push({ kind: 'verse', text: lyricText, words: words.map((w) => w.w), chordAt })
          i += 2
          continue
        }
        lines.push({ kind: 'chords', text: text.replace(/\s+$/, ''), chords: row.chords.map((c) => c.name) })
        i += 1
        continue
      }
      pushPlain(text)
      i += 1
    }
    return { lines, tuning: tuning || 'E A D G C F', toneRoot }
  }

  // ---------------- captura ----------------
  const cap = (s) => String(s || '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase())
  function slugInfo() {
    const parts = location.pathname.split('/').filter(Boolean)
    return {
      slugArtist: (parts[0] || '').replace(/\.html$/, ''),
      slugTitle: (parts[1] || '').replace(/\.html$/, '')
    }
  }
  function textOf(sel) {
    const el = document.querySelector(sel)
    return el ? el.textContent.trim() : ''
  }
  function readNames(slugArtist, slugTitle) {
    let title = textOf('h1')
    let artist = textOf('.header h2 a') || textOf('.header .artista') || textOf('h2 a') || textOf('a.artist')
    if (!title || !artist) {
      const og = (document.querySelector('meta[property="og:title"]')?.content || document.title || '')
        .replace(/cifra\s*club.*$/i, '')
        .replace(/\s*[-–|]\s*$/, '')
        .trim()
      const parts = og.split(/\s+[-–|]\s+/).filter(Boolean)
      if (!title && parts[0]) title = parts[0]
      if (!artist && parts.length >= 2) artist = parts[1]
    }
    return { artist: artist || cap(slugArtist), title: title || cap(slugTitle) }
  }
  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {}
    } catch {
      return {}
    }
  }
  function writeAll(all) {
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {}
  }
  function buildSong() {
    const pre = document.querySelector('pre[data-chord-content="true"]') || document.querySelector('pre')
    if (!pre) return null
    const { slugArtist, slugTitle } = slugInfo()
    if (!slugArtist || !slugTitle) return null
    const parsed = parseCifraHtml(pre.outerHTML)
    const { artist, title } = readNames(slugArtist, slugTitle)
    return {
      artist,
      title,
      slug_artist: slugArtist,
      slug_title: slugTitle,
      tuning: parsed.tuning,
      tone_root: parsed.toneRoot,
      content: parsed.lines
    }
  }
  async function send(song) {
    const res = await fetch(SUPA_URL + '/rest/v1/rpc/capture_song', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + ANON },
      body: JSON.stringify({
        p_token: TOKEN,
        p_artist: song.artist,
        p_title: song.title,
        p_slug_artist: song.slug_artist,
        p_slug_title: song.slug_title,
        p_content: song.content,
        p_tone_root: song.tone_root,
        p_tuning: song.tuning
      })
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }
  async function capture() {
    let song
    try {
      song = buildSong()
    } catch (e) {
      console.warn('Névoa: falha ao ler a cifra —', e.message)
      return null
    }
    if (!song) {
      console.warn('Névoa: nenhuma cifra encontrada nesta página.')
      return null
    }
    const all = readAll()
    all[song.slug_artist + '/' + song.slug_title] = song
    writeAll(all)
    try {
      const r = await send(song)
      console.log(
        (r.status === 'inserted' ? '✅ gravada: ' : '↩︎ já existia: ') +
          song.artist + ' - ' + song.title +
          '  (' + Object.keys(all).length + ' nesta sessão)'
      )
    } catch (e) {
      console.warn('⚠️ capturada localmente, mas não enviou (' + e.message.slice(0, 80) + '). Use nevoa.push()')
    }
    return song
  }
  async function push() {
    const all = readAll()
    const songs = Object.values(all)
    let ok = 0
    for (const s of songs) {
      try {
        await send(s)
        ok++
      } catch {}
    }
    console.log('Névoa: enviadas ' + ok + '/' + songs.length)
    return ok
  }
  function list() {
    const all = readAll()
    console.table(Object.values(all).map((s) => ({ artista: s.artist, titulo: s.title, slug: s.slug_artist + '/' + s.slug_title, linhas: (s.content || []).length })))
    return Object.keys(all).length
  }
  function exportAll() {
    const json = JSON.stringify(Object.values(readAll()))
    try {
      navigator.clipboard && navigator.clipboard.writeText(json)
    } catch {}
    console.log(json)
    console.log('Névoa: JSON copiado para a área de transferência (' + Object.keys(readAll()).length + ' músicas).')
    return json
  }
  function clear() {
    localStorage.removeItem(KEY)
    console.log('Névoa: capturas locais apagadas.')
  }

  window.nevoa = { capture, push, list, export: exportAll, clear, _all: readAll }
  console.log('%cNévoa Captura', 'font-weight:bold;color:#7c5cff')
  console.log('nevoa.capture() captura a música aberta · nevoa.list() · nevoa.export() · nevoa.push()')
  capture()
})()
