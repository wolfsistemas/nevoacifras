import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icons'
import ChordDiagram from '../components/ChordDiagram'
import CifraView from '../components/CifraView'
import { useAuth } from '../hooks/useAuth'
import { callFetchSong } from '../lib/supabase'
import { hasTabs } from '../lib/cifraSanitize'
import { simplifyCifraLines } from '../lib/simplifyCifra'
import { MAJOR_KEYS, MINOR_KEYS, shiftToKey, transposeChord } from '../lib/transpose'
import { attachWakeLock } from '../lib/wakeLock'
import { createMetronome, tapTempo } from '../lib/metronome'
import { readCachedSong } from '../lib/songCache'
import { loadListTone, saveListTone } from '../lib/listTone'
import {
  getSongById,
  getSongBySlug,
  parseSongContent,
  toggleFavorite,
  isFavorite,
  getLists,
  createList,
  addSongToList,
  getListWithSongs,
  recordRecentSong,
  updateListSongTone
} from '../lib/store'

const SETTINGS_KEY = 'nevoa_settings'
const SPEEDS = [6, 10, 14, 20, 28, 40, 55, 70]
const SIZES = [11, 12.5, 14, 16, 18.5, 21.5]
const DEFAULT_SCALE = 2
const INSTRUMENTS = [
  { id: 'violao', label: 'Violão' },
  { id: 'guitarra', label: 'Guitarra' },
  { id: 'teclado', label: 'Teclado' }
]

function verseToPlain(l, shift) {
  const words = l.words || []
  if (!words.length) return []
  let lyric = ''
  const starts = []
  for (let i = 0; i < words.length; i++) {
    starts.push(lyric.length)
    lyric += words[i]
    if (i < words.length - 1) lyric += ' '
  }
  const at = l.chordAt || []
  if (!at.length) return [lyric]
  const line = new Array(lyric.length).fill(' ')
  for (const c of at) {
    const col = starts[c.wi]
    const name = (c.names || []).map(shift).join('/')
    for (let k = 0; k < name.length && col + k < line.length; k++) line[col + k] = name[k]
  }
  return [line.join(''), lyric]
}

function buildPlainText(song, lines, eff) {
  const shift = (name) => transposeChord(name, eff)
  const out = []
  const variant = song.version === 'simplificada' ? ' (versão simplificada)' : ''
  out.push(`${song.artist} - ${song.title}${variant}`)
  if (song.tuning) out.push(`Afinação: ${song.tuning}`)
  if (song.cifraclub_url) out.push(`Fonte: ${song.cifraclub_url}`)
  out.push('')
  for (const l of lines) {
    if (l.kind === 'blank') {
      out.push('')
    } else if (l.kind === 'label') {
      out.push(`[${l.text}]`)
    } else if (l.kind === 'verse') {
      for (const ln of verseToPlain(l, shift)) out.push(ln)
    } else if (l.kind === 'chords') {
      let t = l.text || ''
      for (const c of l.chords || []) t = t.replace(c, shift(c))
      out.push(t)
    } else if (l.kind === 'tab') {
      out.push(l.text || '')
    } else {
      out.push(l.text || '')
    }
  }
  return out.join('\n')
}

function clampScale(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SCALE
  return Math.max(0, Math.min(SIZES.length - 1, Math.round(n)))
}

function loadSettings() {
  const defaults = {
    shift: 0,
    capo: 0,
    auto: false,
    speed: 2,
    scale: DEFAULT_SCALE,
    instrument: 'violao',
    hideTabs: true,
    fontScaleV2: true,
    bpm: 90
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    const next = { ...defaults, ...saved }
    if (saved.fontScaleV2) {
      next.scale = clampScale(saved.scale)
    } else if (saved.scale == null || saved.scale === 1) {
      next.scale = DEFAULT_SCALE
    } else if (saved.scale === 0) {
      next.scale = 3
    } else if (saved.scale === 2) {
      next.scale = 5
    } else {
      next.scale = clampScale(saved.scale)
    }
    next.fontScaleV2 = true
    return next
  } catch {
    return defaults
  }
}

export function SongView({ songId, listId, playlistIds, onBack, onReplaceSong, embedded = false, localToneOnly = false }) {
  const nav = useNavigate()
  const { user } = useAuth()

  const [settings, setSettings] = useState(loadSettings)
  const [song, setSong] = useState(null)
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState('')
  const [fav, setFav] = useState(false)
  const [chord, setChord] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [toneOpen, setToneOpen] = useState(false)
  const [lists, setLists] = useState([])
  const [newList, setNewList] = useState('')
  const baseSongRef = useRef(null)
  const [addedIds, setAddedIds] = useState([])
  const [toast, setToast] = useState('')
  const [copied, setCopied] = useState(false)
  const [neighbors, setNeighbors] = useState({ prev: null, next: null })
  const [listTone, setListTone] = useState(() => (listId ? loadListTone(listId, songId) : null))
  const [metroOn, setMetroOn] = useState(false)
  const [bpm, setBpm] = useState(() => {
    const n = Number(loadSettings().bpm)
    return Number.isFinite(n) ? Math.max(40, Math.min(240, Math.round(n))) : 90
  })
  const [pulse, setPulse] = useState(false)
  const metroRef = useRef(null)
  const tapsRef = useRef([])

  const { auto, speed, scale, instrument, hideTabs } = settings
  const shift = listId ? (listTone?.shift ?? 0) : settings.shift
  const capo = listId ? (listTone?.capo ?? 0) : settings.capo
  const speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, Number(speed) || 0))
  const scaleIdx = clampScale(scale)
  const eff = shift - capo
  const fontSize = SIZES[scaleIdx]
  const pxSpeed = SPEEDS[speedIdx]

  const persist = (patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }

  const persistTone = (patch) => {
    if (listId && songId) {
      setListTone((prev) => {
        const next = { shift: 0, capo: 0, ...(prev || {}), ...patch }
        if (localToneOnly) saveListTone(listId, songId, next)
        else updateListSongTone(listId, songId, next).catch(() => {})
        return next
      })
      return
    }
    persist(patch)
  }

  const persistBpm = (value) => {
    const n = Math.max(40, Math.min(240, Math.round(Number(value) || 90)))
    setBpm(n)
    persist({ bpm: n })
  }

  useEffect(() => {
    ;(async () => {
      setStatus('loading')
      setSong(null)
      setFav(false)
      setChord(null)
      try {
        const s = await getSongById(songId)
        if (!s) throw new Error('Cifra não encontrada.')
        setSong(s)
        recordRecentSong(s, user?.id)
        if (user) isFavorite(s.id).then(setFav)
        setStatus('ok')
      } catch (e) {
        const cached = readCachedSong(songId)
        if (cached) {
          setSong(cached)
          recordRecentSong(cached, user?.id)
          if (user) isFavorite(cached.id).then(setFav)
          setStatus('ok')
          return
        }
        setMessage(e?.message || 'Não foi possível carregar esta cifra.')
        setStatus('error')
      }
    })()
  }, [songId, user])

  useEffect(() => {
    const fromPlaylist = Array.isArray(playlistIds) ? playlistIds.filter(Boolean) : null
    if (fromPlaylist?.length) {
      const idx = fromPlaylist.indexOf(songId)
      if (idx === -1) return
      setNeighbors({
        prev: idx > 0 ? fromPlaylist[idx - 1] : null,
        next: idx < fromPlaylist.length - 1 ? fromPlaylist[idx + 1] : null
      })
      return
    }
    if (!listId) {
      setNeighbors({ prev: null, next: null })
      return
    }
    let cancelled = false
    getListWithSongs(listId)
      .then((list) => {
        if (cancelled || !list) return
        const ids = (list.items || []).map((it) => it.song?.id).filter(Boolean)
        const idx = ids.indexOf(songId)
        setNeighbors({
          prev: idx > 0 ? ids[idx - 1] : null,
          next: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null
        })
      })
      .catch(() => setNeighbors({ prev: null, next: null }))
    return () => {
      cancelled = true
    }
  }, [listId, songId, playlistIds])

  useEffect(() => {
    if (!listId || !songId) {
      setListTone(null)
      return
    }
    setListTone(loadListTone(listId, songId))
    if (localToneOnly) return
    getListWithSongs(listId)
      .then((list) => {
        const item = (list?.items || []).find((it) => it.song?.id === songId)
        if (!item) return
        setListTone({
          shift: item.shift != null ? Number(item.shift) || 0 : 0,
          capo: item.capo != null ? Number(item.capo) || 0 : 0
        })
      })
      .catch(() => {})
  }, [listId, songId, localToneOnly])

  useEffect(() => {
    if (!embedded) return
    document.body.classList.add('song-modal-open')
    return () => document.body.classList.remove('song-modal-open')
  }, [embedded])

  useEffect(() => attachWakeLock(), [])

  useEffect(() => {
    const m = createMetronome()
    metroRef.current = m
    m.setOnBeat(() => {
      setPulse(true)
      setTimeout(() => setPulse(false), 90)
    })
    return () => {
      m.stop()
      metroRef.current = null
    }
  }, [])

  useEffect(() => {
    metroRef.current?.setBpm(bpm)
  }, [bpm])

  useEffect(() => {
    if (!auto) return
    let raf
    let last = null
    const scroller = embedded ? document.querySelector('.song-modal') : window
    const readPos = () => (scroller === window ? window.scrollY : scroller ? scroller.scrollTop : 0)
    // Acumula a posição em float: em velocidades baixas o incremento por frame é
    // menor que 1px e o scrollTop inteiro descartaria o avanço.
    let pos = readPos()
    const step = (ts) => {
      if (last == null) last = ts
      const dt = ts - last
      last = ts
      pos += (pxSpeed * dt) / 1000
      if (scroller === window) window.scrollTo(0, pos)
      else if (scroller) scroller.scrollTop = pos
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [auto, pxSpeed, embedded])

  const togglePresent = async () => {
    const root = document.getElementById('presentation-root')
    try {
      if (!document.fullscreenElement) {
        document.body.classList.add('presentation')
        await (root?.requestFullscreen?.() || Promise.resolve())
      } else {
        await document.exitFullscreen?.()
      }
    } catch {
      document.body.classList.remove('presentation')
    }
  }
  useEffect(() => {
    const onExit = () => document.body.classList.remove('presentation')
    document.addEventListener('fullscreenchange', onExit)
    return () => document.removeEventListener('fullscreenchange', onExit)
  }, [])

  const openLists = async () => {
    setListOpen(true)
    try {
      setLists(await getLists())
    } catch {
      setLists([])
    }
  }

  const handleCreateList = async () => {
    const name = newList.trim()
    if (!name) return
    const list = await createList(name)
    setLists((prev) => [list, ...prev])
    setNewList('')
  }

  const handleAdd = async (list) => {
    if (!song) return
    try {
      await addSongToList(list.id, song.id)
      setAddedIds((prev) => [...prev, list.id])
      showToast(`Adicionada em "${list.name}"`)
    } catch (e) {
      showToast(e?.message || 'Erro ao adicionar.')
    }
  }

  const showToast = (t) => {
    setToast(t)
    setTimeout(() => setToast(''), 2200)
  }

  const goVersion = async (v) => {
    if (!song) return
    if ((song.version || 'original') === v) return
    // volta da simplificada gerada localmente para a original já carregada
    if (v === 'original' && song.generated && baseSongRef.current) {
      setSong(baseSongRef.current)
      return
    }
    setStatus('scraping')
    try {
      let s = await getSongBySlug(song.slug_artist, song.slug_title, v)
      if (!s) {
        const res = await callFetchSong({
          artist: song.slug_artist,
          title: song.slug_title,
          version: v
        })
        s = res.song
      }
      if (!s?.id) throw new Error('Cifra não encontrada.')
      goToSong(s.id)
    } catch (e) {
      // Se o Cifra Club não liberar a versão simplificada, gera localmente a
      // partir da original (mesma estrutura, acordes simplificados).
      if (v === 'simplificada') {
        const base = song.generated && baseSongRef.current ? baseSongRef.current : song
        baseSongRef.current = base
        setSong({
          ...base,
          version: 'simplificada',
          generated: true,
          content: JSON.stringify(simplifyCifraLines(parseSongContent(base)))
        })
        setStatus('ok')
        return
      }
      setMessage(e?.message || 'Não foi possível carregar esta versão.')
      setStatus('error')
    }
  }

  const goToSong = (id) => {
    if (!id) return
    if (onReplaceSong) onReplaceSong(id)
    else nav(`/song/${id}${listId ? `?list=${listId}` : ''}`, { replace: true })
    if (embedded) {
      const root = document.querySelector('.song-modal')
      if (root) root.scrollTop = 0
    } else {
      window.scrollTo(0, 0)
    }
  }

  const goBack = () => {
    if (onBack) onBack()
    else if (listId) nav(`/lists/${listId}`)
    else nav(-1)
  }

  const goNeighbor = (id) => goToSong(id)

  const pickKey = (keyName) => {
    if (!song?.tone_root) return
    persistTone({ shift: shiftToKey(song.tone_root, keyName, capo) })
    setToneOpen(false)
  }

  const toggleMetro = () => {
    const m = metroRef.current
    if (!m) return
    if (metroOn) {
      m.stop()
      setMetroOn(false)
    } else {
      m.setBpm(bpm)
      m.start()
      setMetroOn(true)
    }
  }

  const onTapTempo = () => {
    const { taps, bpm: next } = tapTempo(tapsRef.current)
    tapsRef.current = taps
    if (next) persistBpm(next)
    const m = metroRef.current
    m?.setBpm(next || bpm)
    if (!metroOn) {
      m?.start()
      setMetroOn(true)
    }
  }

  const shareText = () => {
    if (!song) return ''
    const variant = song.version === 'simplificada' ? ' (simplificada)' : ''
    return `${song.artist} - ${song.title}${variant} — cifra no Névoa Cifras: ${window.location.href}`
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      showToast('Link copiado!')
    } catch {
      showToast('Não foi possível copiar.')
    }
  }

  const shareNative = async () => {
    try {
      if (!navigator.share) throw new Error('unsupported')
      await navigator.share({ title: song ? `${song.artist} - ${song.title}` : 'Névoa Cifras', text: shareText(), url: window.location.href })
    } catch {
      setShareOpen(true)
    }
  }

  const downloadTxt = () => {
    if (!song) return
    const lines = parseSongContent(song)
    const text = buildPlainText(song, lines, eff)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${song.slug_artist}-${song.slug_title}${song.version === 'simplificada' ? '-simplificada' : ''}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
    showToast('Baixando arquivo .txt')
  }

  const printPage = () => {
    window.print()
  }

  const setShare = (open) => {
    setShareOpen(open)
    setCopied(false)
  }

  const onFav = async () => {
    if (!song) return
    if (!user) {
      nav('/auth')
      return
    }
    try {
      const now = await toggleFavorite(song.id)
      setFav(now)
      showToast(now ? 'Adicionada aos favoritos' : 'Removida dos favoritos')
    } catch (e) {
      showToast(e?.message || 'Erro.')
    }
  }

  const youtubeHref = useMemo(() => {
    if (!song) return '#'
    if (song.youtube_url) return song.youtube_url
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${song.artist} ${song.title}`)}`
  }, [song])

  if (status === 'loading' || status === 'scraping') {
    return (
      <div className="page center-page" id="presentation-root">
        <div className="spinner" />
        <p>{status === 'scraping' ? 'Buscando a cifra no Cifra Club...' : 'Carregando...'}</p>
        {status === 'scraping' && <p className="muted small">A primeira busca pode demorar alguns segundos.</p>}
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="page center-page" id="presentation-root">
        <p className="big-icon"><Icon name="music" size={40} /></p>
        <h2>Não achamos essa cifra</h2>
        <p className="muted">{message}</p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => nav('/')}>
            Buscar outra
          </button>
          {song?.version === 'simplificada' && (
            <button className="btn" onClick={() => goVersion('original')}>
              Ver versão original
            </button>
          )}
          <button className="btn" onClick={goBack}>
            Voltar
          </button>
        </div>
      </div>
    )
  }

  const version = song.version === 'simplificada' ? 'simplificada' : 'original'
  const toneLabel = song.tone_root ? transposeChord(song.tone_root, eff) : null
  const lines = parseSongContent(song)
  const songHasTabs = hasTabs(lines)
  const visibleLines = hideTabs ? lines.filter((l) => l.kind !== 'tab') : lines
  const currentKey = toneLabel || song.tone_root || ''
  const originalKey = song.tone_root || ''
  const originalIsMinor = /m$/.test(originalKey)

  return (
    <div id="presentation-root" className={`song-page${embedded ? ' song-page-embed' : ''}`} style={{ fontSize: `${fontSize}px` }}>
      <header className="song-head">
        <button className="icon-btn sm" onClick={goBack} aria-label="Voltar">
          <Icon name="back" size={18} />
        </button>
        <div className="song-head-titles">
          <h1>{song.title}</h1>
          <span>{song.artist}</span>
        </div>
        {neighbors.prev || neighbors.next ? (
          <div className="song-head-nav">
            <button
              className="icon-btn sm"
              disabled={!neighbors.prev}
              onClick={() => goNeighbor(neighbors.prev)}
              aria-label="Música anterior da lista"
            >
              <Icon name="prev" size={16} />
            </button>
            <button
              className="icon-btn sm"
              disabled={!neighbors.next}
              onClick={() => goNeighbor(neighbors.next)}
              aria-label="Próxima música da lista"
            >
              <Icon name="next" size={16} />
            </button>
          </div>
        ) : null}
        <button className={`icon-btn sm ${fav ? 'fav-on' : ''}`} onClick={onFav} aria-label="Favoritar">
          <Icon name="heart" size={18} />
        </button>
        <button className="icon-btn sm" onClick={openLists} aria-label="Adicionar a uma lista">
          <Icon name="plus" size={18} />
        </button>
        <a className="icon-btn sm" href={youtubeHref} target="_blank" rel="noreferrer" aria-label="YouTube">
          <Icon name="youtube" size={18} />
        </a>
      </header>

      <div className="song-meta">
        {toneLabel && (
          <button type="button" className="chip chip-btn" onClick={() => setToneOpen(true)}>
            Tom <b>{toneLabel}</b>
          </button>
        )}
        {capo > 0 && <span className="chip">Capotraste <b>{capo}ª casa</b></span>}
        <span className="chip">Afinação {song.tuning || 'padrão'}</span>
        <a className="chip link" href={song.cifraclub_url} target="_blank" rel="noreferrer">
          {song.generated
            ? 'Simplificada (automática)'
            : song.version === 'simplificada'
              ? 'Simplificada no Cifra Club'
              : 'Original no Cifra Club'}
        </a>
      </div>

      <div className="print-only" id="print-header">
        <p className="print-head-title">
          {song.artist} - {song.title}
          {version === 'simplificada' ? ' (versão simplificada)' : ''}
        </p>
        <p className="print-head-meta">
          {toneLabel ? `Tom: ${toneLabel}` : ''}
          {capo > 0 ? ` • Capotraste: ${capo}ª casa` : ''}
          {` • Afinação: ${song.tuning || 'padrão'}`}
          {' • Névoa Cifras'}
        </p>
      </div>

      <div className="toolbar">
        <div className="toolbar-row">
          <div className="seg">
            <button className={version === 'original' ? 'seg-btn on' : 'seg-btn'} onClick={() => goVersion('original')}>
              Original
            </button>
            <button className={version === 'simplificada' ? 'seg-btn on' : 'seg-btn'} onClick={() => goVersion('simplificada')}>
              Simplificada
            </button>
          </div>
          <span className="grow" />
          <button className="icon-btn sm" onClick={() => setShare(true)} aria-label="Compartilhar">
            <Icon name="share" size={16} />
          </button>
          <button className="icon-btn sm" onClick={printPage} aria-label="Imprimir">
            <Icon name="printer" size={16} />
          </button>
          <button className="icon-btn sm" onClick={downloadTxt} aria-label="Baixar arquivo .txt">
            <Icon name="download" size={16} />
          </button>
        </div>
        <div className="toolbar-row">
          <div className="seg">
            {INSTRUMENTS.map((ins) => (
              <button
                key={ins.id}
                className={instrument === ins.id ? 'seg-btn on' : 'seg-btn'}
                onClick={() => persist({ instrument: ins.id })}
              >
                {ins.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-row wrap">
          <button
            type="button"
            className="ctl ctl-link"
            onClick={() => song.tone_root && setToneOpen(true)}
            title="Escolher tom"
          >
            <span className="ctl-label">Tom</span>
            <span className="ctl-value">{eff > 0 ? `+${eff}` : eff}</span>
          </button>

          <div className="ctl">
            <span className="ctl-label">Capo</span>
            <button className="icon-btn sm" onClick={() => persistTone({ capo: Math.max(0, capo - 1) })}>
              <Icon name="a-down" size={16} />
            </button>
            <span className="ctl-value">{capo}</span>
            <button className="icon-btn sm" onClick={() => persistTone({ capo: Math.min(9, capo + 1) })}>
              <Icon name="a-up" size={16} />
            </button>
          </div>

          <div className="ctl grow">
            <span className="ctl-label">Letra</span>
            <button className="icon-btn sm" onClick={() => persist({ scale: Math.max(0, scaleIdx - 1) })}>
              <Icon name="a-down" size={16} />
            </button>
            <span className="ctl-value">{String(SIZES[scaleIdx]).replace('.', ',')}</span>
            <button className="icon-btn sm" onClick={() => persist({ scale: Math.min(SIZES.length - 1, scaleIdx + 1) })}>
              <Icon name="a-up" size={16} />
            </button>
          </div>

          {(shift !== 0 || capo !== 0) && (
            <button className="btn ghost sm-btn" onClick={() => persistTone({ shift: 0, capo: 0 })}>
              Resetar
            </button>
          )}
        </div>

        <div className="toolbar-row wrap">
          <div className="ctl">
            <button
              className={`icon-btn sm ${auto ? 'on' : ''}`}
              onClick={() => persist({ auto: !auto })}
              aria-label="Rolagem automática"
            >
              <Icon name="repeat" size={16} />
            </button>
            <span className="ctl-label">{auto ? 'Rolando' : 'Auto-scroll'}</span>
          </div>
          <div className="ctl grow">
            <input
              type="range"
              min={0}
              max={SPEEDS.length - 1}
              step={1}
              value={speedIdx}
              onChange={(e) => persist({ speed: +e.target.value })}
              aria-label="Velocidade do auto-scroll"
            />
            <span className="ctl-label">{pxSpeed}px/s</span>
          </div>
          {songHasTabs && (
            <button
              className={`btn ghost sm-btn ${hideTabs ? '' : 'on-soft'}`}
              onClick={() => persist({ hideTabs: !hideTabs })}
            >
              {hideTabs ? 'Mostrar tabs' : 'Ocultar tabs'}
            </button>
          )}
          <button className="icon-btn sm" onClick={togglePresent} aria-label="Tela cheia">
            <Icon name="fullscreen" size={16} />
          </button>
        </div>

        <div className="toolbar-row wrap">
          <button
            className={`icon-btn sm ${metroOn ? 'metro-on' : ''} ${pulse ? 'pulse' : ''}`}
            onClick={toggleMetro}
            aria-label="Metrônomo"
          >
            <Icon name="metronome" size={16} />
          </button>
          <span className="ctl-label">BPM</span>
          <div className="ctl grow">
            <button className="icon-btn sm" onClick={() => persistBpm(bpm - 2)} aria-label="BPM menor">
              <Icon name="a-down" size={16} />
            </button>
            <span className="ctl-value">{bpm}</span>
            <button className="icon-btn sm" onClick={() => persistBpm(bpm + 2)} aria-label="BPM maior">
              <Icon name="a-up" size={16} />
            </button>
          </div>
          <button className="btn ghost sm-btn" onClick={onTapTempo}>
            Tap
          </button>
        </div>
      </div>

      {visibleLines.length === 0 ? (
        <p className="muted center">Esta cifra está vazia ou ainda não foi carregada.</p>
      ) : (
        <CifraView lines={lines} shift={eff} onChord={setChord} hideTabs={hideTabs} />
      )}

      <footer className="song-footer">
        <a href={song.cifraclub_url} target="_blank" rel="noreferrer">
          Cifra via Cifra Club
        </a>
        <span>Névoa Cifras</span>
      </footer>

      {chord && (
        <div className="sheet-backdrop chord-card-backdrop" onClick={() => setChord(null)}>
          <div className="sheet chord-card" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn sm sheet-close" onClick={() => setChord(null)} aria-label="Fechar">
              <Icon name="close" size={16} />
            </button>
            <ChordDiagram chord={chord} instrument={instrument} />
          </div>
        </div>
      )}

      {toneOpen && (
        <div className="sheet-backdrop" onClick={() => setToneOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Escolher tom</h3>
            <p className="muted small">Maior</p>
            <div className="key-grid">
              {MAJOR_KEYS.map((k) => (
                <button
                  key={k}
                  className={`key-btn${currentKey === k ? ' on' : ''}${!originalIsMinor && originalKey === k ? ' origin' : ''}`}
                  onClick={() => pickKey(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            <p className="muted small">Menor</p>
            <div className="key-grid">
              {MINOR_KEYS.map((k) => (
                <button
                  key={k}
                  className={`key-btn${currentKey === k ? ' on' : ''}${originalIsMinor && originalKey === k ? ' origin' : ''}`}
                  onClick={() => pickKey(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            {originalKey && (
              <p className="muted small key-legend">
                <i className="key-dot" /> Tom original: <b>{originalKey}</b>
              </p>
            )}
          </div>
        </div>
      )}

      {shareOpen && (
        <div className="sheet-backdrop" onClick={() => setShare(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Compartilhar e imprimir</h3>
            <div className="sheet-list">
              <button className="sheet-row sheet-action" onClick={copyLink}>
                <span className="grow">Copiar link</span>
                <span className={copied ? 'chip ok' : 'chip'}>{copied ? 'Copiado' : <Icon name="link" size={16} />}</span>
              </button>
              <a
                className="sheet-row sheet-action"
                href={`https://wa.me/?text=${encodeURIComponent(shareText())}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="grow">WhatsApp</span>
                <Icon name="wa" size={18} />
              </a>
              {navigator.share && (
                <button className="sheet-row sheet-action" onClick={shareNative}>
                  <span className="grow">Mais opções...</span>
                  <Icon name="share" size={18} />
                </button>
              )}
              <button className="sheet-row sheet-action" onClick={printPage}>
                <span className="grow">Imprimir</span>
                <Icon name="printer" size={18} />
              </button>
              <button className="sheet-row sheet-action" onClick={downloadTxt}>
                <span className="grow">Baixar arquivo .txt</span>
                <Icon name="download" size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {listOpen && (
        <div className="sheet-backdrop" onClick={() => setListOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Adicionar à lista</h3>
            {!user ? (
              <p className="muted">
                <button className="btn-link" onClick={() => nav('/auth')}>
                  Entre com sua conta
                </button>{' '}
                para criar listas.
              </p>
            ) : (
              <>
                <div className="row">
                  <input
                    className="grow"
                    value={newList}
                    placeholder="Nome da nova lista"
                    onChange={(e) => setNewList(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateList()}
                  />
                  <button className="btn btn-primary btn-icon" onClick={handleCreateList} aria-label="Criar lista">
                    <Icon name="plus" size={18} />
                  </button>
                </div>
                <div className="sheet-list">
                  {lists.length === 0 && <p className="muted">Você ainda não tem listas.</p>}
                  {lists.map((l) => (
                    <div key={l.id} className="sheet-row">
                      <span className="grow">
                        {l.name} <small className="muted">({l.count})</small>
                      </span>
                      {addedIds.includes(l.id) ? (
                        <span className="chip ok">Adicionada</span>
                      ) : (
                        <button className="btn ghost sm-btn" onClick={() => handleAdd(l)}>
                          Adicionar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default function Song() {
  const { songId } = useParams()
  const [params] = useSearchParams()
  const listId = params.get('list')
  return <SongView key={`${listId || ''}-${songId}`} songId={songId} listId={listId} />
}
