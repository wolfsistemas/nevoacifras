import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icons'
import SongCard from '../components/SongCard'
import { useAuth } from '../hooks/useAuth'
import { callFetchSong } from '../lib/supabase'
import { listRecentSongs, searchSongsLocal } from '../lib/store'
import { searchRemoteSongs, mergeHits, resolveCifraHit } from '../lib/musicSearch'

function hitKey(h) {
  return `${h.slug_artist || ''}|${h.slug_title || ''}|${h.id || ''}|${h.artist}|${h.title}`
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [recent, setRecent] = useState([])
  const [hits, setHits] = useState([])
  const [busy, setBusy] = useState(false)
  const [setupHint, setSetupHint] = useState(false)
  const [notice, setNotice] = useState('')
  const deb = useRef(null)
  const lastQ = useRef('')

  useEffect(() => {
    if (!user) {
      setRecent([])
      return
    }
    listRecentSongs(user.id)
      .then(setRecent)
      .catch((e) => {
        setSetupHint(/does not exist|relation|Failed to fetch|fetch/i.test(String(e?.message || e)))
      })
  }, [user])

  useEffect(() => {
    clearTimeout(deb.current)
    const value = q.trim()
    if (!value) {
      setHits([])
      setNotice('')
      return
    }
    deb.current = setTimeout(() => {
      runSearch(value, false)
    }, 320)
    return () => clearTimeout(deb.current)
  }, [q])

  const openSong = async (hit) => {
    setBusy(true)
    setNotice('')
    try {
      if (hit.id) {
        nav(`/song/${hit.id}`)
        return
      }
      setNotice('Abrindo a cifra no Cifra Club...')
      const resolved = await resolveCifraHit(hit)
      const res = await callFetchSong({
        artist: resolved.slug_artist || resolved.artist,
        title: resolved.slug_title || resolved.title,
        slug_artist: resolved.slug_artist,
        slug_title: resolved.slug_title
      })
      const s = res?.song
      if (!s?.id) throw new Error('Não encontramos essa cifra.')
      nav(`/song/${s.id}`)
    } catch (e) {
      setNotice(e?.message || 'Não foi possível abrir essa cifra.')
    } finally {
      setBusy(false)
    }
  }

  const runSearch = async (value, fromSubmit) => {
    if (!value) return
    lastQ.current = value
    if (fromSubmit) {
      setBusy(true)
      setNotice('Procurando cifras...')
    }
    try {
      const [local, remote] = await Promise.all([
        searchSongsLocal(value, 10).catch(() => []),
        searchRemoteSongs(value, 10).catch(() => [])
      ])
      if (lastQ.current !== value) return
      const list = mergeHits(local, remote)
      setHits(list)
      setSetupHint(false)
      if (fromSubmit && list.length === 1) {
        await openSong(list[0])
        return
      }
      if (fromSubmit && list.length === 0) {
        setNotice('Não encontramos cifras com esse nome. Tente outro trecho.')
      } else if (fromSubmit) {
        setNotice('')
      }
    } catch (e) {
      if (lastQ.current !== value) return
      setNotice(e?.message || 'Não foi possível buscar agora.')
    } finally {
      if (fromSubmit) setBusy(false)
    }
  }

  const submit = (e) => {
    e?.preventDefault()
    const value = q.trim()
    if (!value) {
      setNotice('Digite o nome da música — o artista é opcional.')
      return
    }
    runSearch(value, true)
  }

  return (
    <div className="page">
      <header className="home-hero">
        <div className="home-logo">
          <span className="logo-dot" />
          <h1>Névoa Cifras</h1>
        </div>
        <p className="home-tag">
          Digite só o nome da música. Eu mostro as cifras mais próximas para você escolher.
        </p>
      </header>

      <form className="search-box" onSubmit={submit}>
        <div className="search-row">
          <Icon name="search" size={20} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Busque "me ama", "the scientist" ou o artista'
            aria-label="Buscar cifra"
            autoComplete="off"
          />
          <button type="submit" className="btn btn-primary btn-icon" aria-label="Buscar cifra" disabled={busy}>
            {busy ? <span className="mini-spin" /> : <Icon name="arrow" size={18} />}
          </button>
        </div>
        {notice && <p className="form-error">{notice}</p>}
      </form>

      {hits.length > 0 && (
        <section className="suggestions">
          <h2 className="section-title">Cifras encontradas</h2>
          <div className="suggest-list">
            {hits.map((s) => (
              <SongCard
                key={hitKey(s)}
                song={s}
                onOpen={openSong}
                trailing={
                  <span className="btn ghost icon-only" aria-hidden="true">
                    <Icon name="play" size={18} />
                  </span>
                }
              />
            ))}
          </div>
          <p className="muted small">Toque numa cifra para abrir. O artista não precisa estar no texto da busca.</p>
        </section>
      )}

      {setupHint && (
        <div className="setup-hint">
          <p>O catálogo ainda não respondeu.</p>
          <p>
            Confira se o banco do Supabase foi criado com <code>supabase/schema.sql</code> e se as
            chaves estão em <code>.env</code>.
          </p>
        </div>
      )}

      <section className="recent">
        <h2 className="section-title">Recentes</h2>
        {busy && <p className="muted">Buscando cifra...</p>}
        {!user && !busy && (
          <p className="muted">Entre na sua conta para ver as cifras que você abriu.</p>
        )}
        {user && recent.length === 0 && !busy && !setupHint && (
          <p className="muted">Nenhuma cifra ainda. Busque uma música para começar.</p>
        )}
        <div className="card-grid">
          {recent.map((s) => (
            <SongCard key={s.id} song={s} />
          ))}
        </div>
      </section>
    </div>
  )
}
