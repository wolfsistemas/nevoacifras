// Névoa Captura — roda no console ou via bookmarklet numa página do Cifra Club.
//  - Numa página de música: captura a cifra aberta.
//  - Numa página de artista/álbum: captura TODAS as músicas listadas.
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

  // ---------------- nomes/slugs ----------------
  const cap = (s) => String(s || '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase())
  function slugInfoFromPath(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean)
    return {
      slugArtist: (parts[0] || '').replace(/\.html?$/i, ''),
      slugTitle: (parts[1] || '').replace(/\.html?$/i, '')
    }
  }
  function readNames(root, slugArtist, slugTitle) {
    const textOf = (sel) => {
      const el = root.querySelector(sel)
      return el ? el.textContent.trim() : ''
    }
    let title = textOf('h1')
    let artist = textOf('.header h2 a') || textOf('.header .artista') || textOf('h2 a') || textOf('a.artist')
    if (!title || !artist) {
      const og = (root.querySelector('meta[property="og:title"]')?.content || root.title || '')
        .replace(/cifra\s*club.*$/i, '')
        .replace(/\s*[-–|]\s*$/, '')
        .trim()
      const parts = og.split(/\s+[-–|]\s+/).filter(Boolean)
      if (!title && parts[0]) title = parts[0]
      if (!artist && parts.length >= 2) artist = parts[1]
    }
    return { artist: artist || cap(slugArtist), title: title || cap(slugTitle) }
  }
  function buildSongFromHtml(html, root, slugArtist, slugTitle) {
    const parsed = parseCifraHtml(html)
    const { artist, title } = readNames(root, slugArtist, slugTitle)
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

  // ---------------- armazenamento/envio ----------------
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
  function remember(song) {
    const all = readAll()
    all[song.slug_artist + '/' + song.slug_title] = song
    writeAll(all)
    return Object.keys(all).length
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

  // ---------------- página de música ----------------
  function currentSongPage() {
    const pre = document.querySelector('pre[data-chord-content="true"]') || document.querySelector('pre')
    if (!pre) return null
    const { slugArtist, slugTitle } = slugInfoFromPath(location.pathname)
    if (!slugArtist || !slugTitle) return null
    return buildSongFromHtml(document.documentElement.outerHTML, document, slugArtist, slugTitle)
  }
  async function capture() {
    let song
    try {
      song = currentSongPage()
    } catch (e) {
      console.warn('Névoa: falha ao ler a cifra —', e.message)
      return null
    }
    if (!song) {
      console.warn('Névoa: nenhuma cifra encontrada nesta página.')
      return null
    }
    const n = remember(song)
    try {
      const r = await send(song)
      console.log((r.status === 'inserted' ? '✅ gravada: ' : '↩︎ já existia: ') + song.artist + ' - ' + song.title + '  (' + n + ' nesta sessão)')
    } catch (e) {
      console.warn('⚠️ capturada localmente, mas não enviou (' + e.message.slice(0, 80) + '). Use nevoa.push()')
    }
    return song
  }

  // ---------------- página de artista/álbum ----------------
  const SITE_HOSTS = ['www.cifraclub.com.br', 'cifraclub.com.br']
  // Segundos segmentos que NÃO são músicas (páginas de apoio/variações).
  const PAGE_BLOCKLIST = new Set([
    'fotos', 'discografia', 'albuns', 'albuns-e-singles', 'playlists', 'videos',
    'biografia', 'letras', 'cifras', 'musicas', 'traducoes', 'notas', 'versoes',
    'partituras', 'tabs-baixo', 'tabs', 'letra', 'imprimir', 'simplificada',
    'videoaula', 'videoaulas', 'avaliacoes', 'comentarios'
  ])
  // Rotas de primeiro nível que nunca são de música/artista.
  const RESERVED_ROUTES = new Set([
    'explorar', 'busca', 'mais-acessadas', 'estilos', 'blog', 'academy', 'forum',
    'pro', 'letras', 'letra', 'cifras', 'musico', 'top', 'cursos', 'partituras',
    'tabs', 'videoaulas', 'aulas', 'noticias', 'encontre', 'escolas', 'app', 'apps',
    'login', 'cadastro', 'loja', 'artistas', 'musicas', 'generos', 'playlists',
    'videos', 'config', 'history', 'menu', 'search', 'en', 'es'
  ])
  // Seções de recomendação/"toque também" que não pertencem à página.
  const RECO_SELECTOR = '.playToo, .thumb_big, .related, .js-related, .lastChords, .top-artists'
  function onCifraclub() {
    return SITE_HOSTS.includes(location.hostname)
  }
  function hasSongContent() {
    return !!document.querySelector('pre[data-chord-content="true"]')
  }
  function hasArtistMarker() {
    return !!document.querySelector('#js-artistName, #js-a-songs, h1.art-header, ul.artistMusics--allSongs, #js-a-t-more')
  }
  function isExploreSongsPage() {
    return /^\/explorar\/musicas(\/|$)/.test(location.pathname)
  }
  function artistSlugNow() {
    return location.pathname.split('/').filter(Boolean)[0] || ''
  }
  // Coleta TODOS os links de música da página (artista, álbum, playlist, explore).
  // Um link de música é /{artista}/{musica}/.
  function collectSongsFrom(root, originHost) {
    const seen = new Set()
    const out = []
    root.querySelectorAll('a[href]').forEach((a) => {
      if (a.closest(RECO_SELECTOR)) return
      let url
      try {
        url = new URL(a.getAttribute('href'), 'https://www.cifraclub.com.br')
      } catch {
        return
      }
      if (!SITE_HOSTS.includes(url.hostname)) return
      if (originHost && url.hostname !== originHost) return
      if (url.search || url.hash) return
      if (/\.html?$/i.test(url.pathname)) return
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2) return
      const sa = parts[0]
      const st = parts[1]
      if (!sa || !st) return
      if (RESERVED_ROUTES.has(sa)) return
      if (PAGE_BLOCKLIST.has(st)) return
      const key = sa + '/' + st
      if (seen.has(key)) return
      seen.add(key)
      out.push({ slugArtist: sa, slugTitle: st, url: url.origin + '/' + sa + '/' + st + '/' })
    })
    return out
  }
  function collectSongs() {
    const all = collectSongsFrom(document)
    // Em página de artista/álbum, mantém só as músicas daquele artista.
    const pageSlug = artistSlugNow()
    if (pageSlug && !RESERVED_ROUTES.has(pageSlug)) {
      const mine = all.filter((s) => s.slugArtist === pageSlug)
      if (mine.length) return mine
    }
    // Em "explore" filtrado por artista, mantém o artista dominante.
    if (isExploreSongsPage() && all.length) {
      const counts = {}
      for (const s of all) counts[s.slugArtist] = (counts[s.slugArtist] || 0) + 1
      let best = null
      let bestN = 0
      for (const k of Object.keys(counts)) if (counts[k] > bestN) ((bestN = counts[k]), (best = k))
      if (best && bestN >= all.length * 0.6) return all.filter((s) => s.slugArtist === best)
    }
    return all
  }
  function isListingPage() {
    if (!onCifraclub() || hasSongContent()) return false
    if (isExploreSongsPage()) return true
    const slug = artistSlugNow()
    const songs = collectSongs()
    if (hasArtistMarker()) return songs.length > 0
    // Layouts antigos (ex.: alguns artistas) não têm marcador: aceita se houver
    // vários links de música sob o mesmo primeiro segmento da URL.
    return songs.filter((s) => s.slugArtist === slug).length >= 2
  }
  function findNextPage() {
    const links = []
    document.querySelectorAll('a[href]').forEach((a) => {
      let url
      try {
        url = new URL(a.getAttribute('href'), location.origin)
      } catch {
        return
      }
      if (!SITE_HOSTS.includes(url.hostname)) return
      if (/[?&](pagina|page|p)=\d+/i.test(url.search) || /\/pagina\/\d+/i.test(url.pathname) || /\/page\/\d+/i.test(url.pathname)) links.push(url.href)
    })
    return [...new Set(links)]
  }
  async function captureUrl(link) {
    const res = await fetch(link.url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const html = await res.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const song = buildSongFromHtml(html, doc, link.slugArtist, link.slugTitle)
    remember(song)
    return send(song)
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  function findMoreButtons() {
    const btns = []
    document.querySelectorAll('#js-a-t-more, [data-qnt][data-max]').forEach((b) => btns.push(b))
    document.querySelectorAll('button, input[type="button"]').forEach((b) => {
      const t = (b.textContent || b.value || '').toLowerCase()
      if (/mostrar mais|carregar mais|mais m[úu]sicas/.test(t)) btns.push(b)
    })
    return [...new Set(btns)]
  }
  // Muitas listas carregam o resto por AJAX ("Mostrar mais"). Clicamos até parar.
  async function expandAll() {
    let last = collectSongs().length
    for (let k = 0; k < 40; k++) {
      const btns = findMoreButtons().filter((b) => !b.disabled && b.offsetParent !== null)
      if (!btns.length) break
      let clicked = false
      for (const b of btns) {
        try {
          b.click()
          clicked = true
        } catch {}
      }
      if (!clicked) break
      await wait(900)
      const now = collectSongs().length
      if (now <= last && k >= 1) break
      last = now
    }
    if (last) console.log('Névoa: lista com ' + last + ' músicas.')
  }
  async function saveSongs(songs) {
    const s = { ins: 0, exi: 0, dup: 0, err: 0, blocked: 0 }
    for (let i = 0; i < songs.length; i++) {
      const link = songs[i]
      try {
        const r = await captureUrl(link)
        if (r.status === 'inserted') s.ins++
        else if (r.status === 'duplicate') s.dup++
        else s.exi++
        const tag = r.status === 'inserted' ? 'gravada' : r.status === 'duplicate' ? 'duplicada' : 'já existia'
        console.log('  [' + (i + 1) + '/' + songs.length + '] ' + tag + ': ' + link.slugArtist + '/' + link.slugTitle)
      } catch (e) {
        s.err++
        if (/HTTP 403|HTTP 429|Failed to fetch/i.test(e.message)) s.blocked++
        console.warn('  [' + (i + 1) + '/' + songs.length + '] falhou ' + link.slugArtist + '/' + link.slugTitle + ' — ' + e.message.slice(0, 60))
        if (s.blocked >= 5) {
          console.warn('Névoa: bloqueio temporário do Cifra Club. Parei; espere alguns minutos e rode de novo (o que já gravou fica salvo).')
          break
        }
      }
      await wait(350)
    }
    console.log('Névoa: lote → gravadas ' + s.ins + ' · já existiam ' + s.exi + ' · duplicadas ' + s.dup + ' · erros ' + s.err)
    return s
  }
  function mergeSongs(queue, extra) {
    const seen = new Set(queue.map((q) => q.slugArtist + '/' + q.slugTitle))
    for (const l of extra) {
      const key = l.slugArtist + '/' + l.slugTitle
      if (!seen.has(key)) {
        seen.add(key)
        queue.push(l)
      }
    }
  }
  async function artist(followPages) {
    if (hasSongContent()) {
      console.warn('Névoa: esta é uma página de música. Use nevoa.capture().')
      return
    }
    if (!onCifraclub()) {
      console.warn('Névoa: abra uma página do Cifra Club primeiro.')
      return
    }
    await expandAll()
    const queue = collectSongs()
    if (followPages) {
      for (const pageUrl of findNextPage().slice(0, 20)) {
        try {
          const res = await fetch(pageUrl)
          const html = await res.text()
          const doc = new DOMParser().parseFromString(html, 'text/html')
          mergeSongs(queue, collectSongsFrom(doc))
        } catch {}
      }
    }
    if (!queue.length) {
      console.warn('Névoa: não achei músicas nesta página. Rode nevoa.preview() para ver o que o script enxerga.')
      return
    }
    console.log('Névoa: ' + queue.length + ' músicas encontradas. Capturando...')
    await saveSongs(queue)
  }
  // Percorre "Explorar > Músicas" por gênero, em lotes automáticos.
  // Ex.: nevoa.genre()                          // Gospel (30), contínuo até o fim
  //      nevoa.genre({ pages: 40 })             // só 40 páginas e para
  //      nevoa.genre({ resume: true })          // continua de onde parou
  //      nevoa.genre({ capture: false })        // só lista, não baixa as cifras
  async function genre(opts) {
    opts = opts || {}
    const g = opts.genre || 30
    const doCapture = opts.capture !== false
    const batch = opts.batch || 15
    const maxPages = opts.pages || 0
    const pause = opts.pause == null ? 8000 : opts.pause
    const delay = opts.delay == null ? 500 : opts.delay
    const resumeKey = 'nevoa_genre_' + g
    if (!onCifraclub()) {
      console.warn('Névoa: abra uma página do Cifra Club primeiro.')
      return
    }
    let page = opts.from || 1
    if (opts.resume) {
      const saved = parseInt(localStorage.getItem(resumeKey) || '0', 10)
      if (saved) {
        page = saved + 1
        console.log('Névoa: retomando a partir da página ' + page + '.')
      }
    }
    const seen = new Set()
    const collected = []
    let pending = []
    let empty = 0
    let processed = 0
    let done = false
    const total = { ins: 0, exi: 0, dup: 0, err: 0, blocked: 0, found: 0 }
    console.log('Névoa: gênero ' + g + ' · começando na página ' + page + (maxPages ? ' · ' + maxPages + ' páginas' : ' · contínuo até o fim') + '.')
    while (!done) {
      if (maxPages && processed >= maxPages) {
        console.log('Névoa: limite de ' + maxPages + ' páginas alcançado.')
        break
      }
      const url = 'https://www.cifraclub.com.br/explorar/musicas/?genre=' + g + '&page=' + page
      let doc
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const html = await res.text()
        doc = new DOMParser().parseFromString(html, 'text/html')
      } catch (e) {
        if (/403|429|Failed to fetch/i.test(e.message)) {
          console.warn('Névoa: bloqueio na página ' + page + ' (' + e.message + '). Parei; espere alguns minutos e rode nevoa.genre({ resume: true }).')
          done = true
          break
        }
        console.warn('Névoa: página ' + page + ' falhou — ' + e.message.slice(0, 60))
        page++
        processed++
        continue
      }
      const found = collectSongsFrom(doc, 'www.cifraclub.com.br')
      let added = 0
      for (const s of found) {
        const k = s.slugArtist + '/' + s.slugTitle
        if (!seen.has(k)) {
          seen.add(k)
          pending.push(s)
          collected.push(s)
          added++
        }
      }
      total.found += found.length
      localStorage.setItem(resumeKey, String(page))
      console.log('Névoa: página ' + page + ' → ' + found.length + ' músicas (' + added + ' novas · ' + pending.length + ' no lote)')
      if (found.length === 0) {
        empty++
        if (empty >= 2) {
          console.log('Névoa: fim dos resultados na página ' + page + '.')
          done = true
        }
      } else {
        empty = 0
      }
      page++
      processed++
      if (doCapture && pending.length && (processed % batch === 0 || done)) {
        const s = await saveSongs(pending)
        pending = []
        total.ins += s.ins; total.exi += s.exi; total.dup += s.dup; total.err += s.err; total.blocked += s.blocked
        if (s.blocked >= 5) {
          done = true
        } else if (!done && processed % batch === 0) {
          console.log('Névoa: lote concluído (' + processed + ' páginas). Pausando ' + Math.round(pause / 1000) + 's...')
          await wait(pause)
        }
      } else if (!done) {
        await wait(delay)
      }
    }
    if (doCapture && pending.length) {
      const s = await saveSongs(pending)
      total.ins += s.ins; total.exi += s.exi; total.dup += s.dup; total.err += s.err; total.blocked += s.blocked
    }
    window.nevoa._lastLinks = collected
    console.log('Névoa: fim. gravadas ' + total.ins + ' · já existiam ' + total.exi + ' · duplicadas ' + total.dup + ' · erros ' + total.err + ' · próxima página: ' + page)
    if (total.blocked) console.log('Névoa: houve bloqueio; rode nevoa.genre({ resume: true }) mais tarde.')
    return { page: page, ins: total.ins, exi: total.exi, dup: total.dup, err: total.err, blocked: total.blocked, links: collected }
  }

  function preview() {
    const songs = collectSongs()
    console.log('Névoa: ' + songs.length + ' links de música encontrados (nada foi enviado):')
    console.table(songs.map((s) => ({ artista: s.slugArtist, musica: s.slugTitle })))
    return songs
  }

  // ---------------- utilitários ----------------
  async function push() {
    const songs = Object.values(readAll())
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
    console.log('Névoa: JSON copiado (' + Object.keys(readAll()).length + ' músicas).')
    return json
  }
  function clear() {
    localStorage.removeItem(KEY)
    console.log('Névoa: capturas locais apagadas.')
  }

  window.nevoa = { capture, artist, save: artist, genre, preview, push, list, export: exportAll, clear, _all: readAll }
  console.log('%cNévoa Captura', 'font-weight:bold;color:#7c5cff')
  console.log('Música: nevoa.capture() · Lista (artista/álbum/explore): nevoa.artist() · Gospel em lotes: nevoa.genre() · Parar/continuar: nevoa.genre({ resume: true }) · nevoa.preview() mostra o que achou · nevoa.list() · nevoa.export() · nevoa.push()')

  if (hasSongContent()) {
    capture()
  } else if (isListingPage()) {
    console.log('Página com lista de músicas detectada — capturando tudo...')
    artist(false)
  } else if (onCifraclub()) {
    console.warn('Névoa: não achei cifra nem lista de músicas aqui. Se for uma lista, rode nevoa.preview() para ver o que o script enxerga.')
  } else {
    console.warn('Névoa: abra uma página do Cifra Club (a cifra, o artista ou uma lista) e rode de novo.')
  }
})()
