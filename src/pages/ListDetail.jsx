import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Icon } from '../components/Icons'
import SongCard from '../components/SongCard'
import ListChat from '../components/ListChat'
import { SongView } from './Song'
import { callFetchSong } from '../lib/supabase'
import { searchRemoteSongs, mergeHits, resolveCifraHit } from '../lib/musicSearch'
import { MAJOR_KEYS, MINOR_KEYS, keySemitone, normalizeShift, signedDelta } from '../lib/transpose'
import { detectKey } from '../lib/keyDetect'
import {
  getListWithSongs,
  removeSongFromList,
  moveListSong,
  renameList,
  addSongToList,
  searchSongsLocal,
  shareList,
  unshareList,
  getSongsKeyInfo,
  parseSongContent,
  updateListSongTone
} from '../lib/store'

function hitKey(h) {
  return `${h.slug_artist || ''}|${h.slug_title || ''}|${h.id || ''}|${h.artist}|${h.title}`
}

export default function ListDetail() {
  const { id } = useParams()
  const [list, setList] = useState(null)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [addedKeys, setAddedKeys] = useState([])
  const [openSongId, setOpenSongId] = useState(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareMsg, setShareMsg] = useState('')
  const [toneOpen, setToneOpen] = useState(false)
  const [toneBusy, setToneBusy] = useState(false)
  const [toneNotice, setToneNotice] = useState('')
  const [songKeys, setSongKeys] = useState({})
  const deb = useRef(null)
  const lastQ = useRef('')

  const load = () =>
    getListWithSongs(id)
      .then(setList)
      .catch(() => setNotice('Não deu para abrir esta lista agora. Verifique a conexão.'))

  useEffect(() => {
    load()
  }, [id])

  useEffect(() => {
    if (!searchOpen) return
    clearTimeout(deb.current)
    const value = q.trim()
    if (!value) {
      setHits([])
      setNotice('')
      return
    }
    deb.current = setTimeout(() => runSearch(value), 280)
    return () => clearTimeout(deb.current)
  }, [q, searchOpen])

  const runSearch = async (value) => {
    lastQ.current = value
    try {
      const [local, remote] = await Promise.all([
        searchSongsLocal(value, 10).catch(() => []),
        searchRemoteSongs(value, 10).catch(() => [])
      ])
      if (lastQ.current !== value) return
      setHits(mergeHits(local, remote))
    } catch {
      if (lastQ.current !== value) return
      setHits([])
    }
  }

  const addHit = async (hit) => {
    setBusy(true)
    setNotice('')
    try {
      let songId = hit.id
      if (!songId) {
        const resolved = await resolveCifraHit(hit)
        const res = await callFetchSong({
          artist: resolved.slug_artist || resolved.artist,
          title: resolved.slug_title || resolved.title,
          slug_artist: resolved.slug_artist,
          slug_title: resolved.slug_title
        })
        songId = res?.song?.id
      }
      if (!songId) throw new Error('Não encontramos essa cifra.')
      await addSongToList(id, songId)
      setAddedKeys((prev) => [...prev, hitKey(hit)])
      await load()
    } catch (e) {
      setNotice(e?.message || 'Não foi possível adicionar.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (item) => {
    await removeSongFromList(item.id)
    load()
  }

  const move = async (item, dir) => {
    try {
      await moveListSong(item.id, dir)
      load()
    } catch {}
  }

  const saveName = async () => {
    const n = name.trim()
    if (n) await renameList(id, n)
    setEditing(false)
    load()
  }

  const shareUrlFor = (token) => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = `#/share/${token}`
    return url.toString()
  }

  const enableShare = async () => {
    setShareBusy(true)
    setShareMsg('')
    try {
      const token = await shareList(id)
      setList((prev) => ({ ...prev, share_token: token, is_public: true }))
      try {
        await navigator.clipboard.writeText(shareUrlFor(token))
        setShareMsg('Link criado e copiado!')
      } catch {
        setShareMsg('Link criado. Copie acima.')
      }
    } catch (e) {
      setShareMsg(e?.message || 'Não foi possível compartilhar.')
    } finally {
      setShareBusy(false)
    }
  }

  const disableShare = async () => {
    setShareBusy(true)
    setShareMsg('')
    try {
      await unshareList(id)
      setList((prev) => ({ ...prev, is_public: false }))
      setShareMsg('Compartilhamento desativado.')
    } catch (e) {
      setShareMsg(e?.message || 'Não foi possível desativar.')
    } finally {
      setShareBusy(false)
    }
  }

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrlFor(list.share_token))
      setShareMsg('Link copiado!')
    } catch {
      setShareMsg('Não foi possível copiar. Selecione o link acima.')
    }
  }

  if (!list) return <div className="page center-page">Carregando...</div>

  const items = list.items || []
  const readOnly = !!list.is_readonly
  const chatToken = list.share_token || list.shared_from_token || null

  const openStandardize = async () => {
    setToneNotice('')
    setSongKeys({})
    setToneOpen(true)
    setToneBusy(true)
    try {
      const ids = items.map((it) => it.song?.id).filter(Boolean)
      const info = await getSongsKeyInfo(ids)
      const map = {}
      for (const it of items) {
        const sid = it.song?.id
        if (!sid) continue
        let key = info[sid] ? detectKey(parseSongContent(info[sid])) : null
        if (!key) {
          const semi = keySemitone(it.song?.tone_root)
          if (semi != null) key = { root: semi, mode: 'major' }
        }
        if (key) map[sid] = key
      }
      setSongKeys(map)
      if (!Object.keys(map).length) setToneNotice('Não conseguimos analisar as cifras desta lista.')
    } catch (e) {
      setToneNotice(e?.message || 'Não foi possível analisar as cifras agora.')
    } finally {
      setToneBusy(false)
    }
  }

  const applyStandardTone = async (targetKeyName) => {
    const targetSemi = keySemitone(targetKeyName)
    if (targetSemi == null) return
    const targetMode = /m$/.test(targetKeyName) ? 'minor' : 'major'
    setToneBusy(true)
    setToneNotice('')
    try {
      const updates = []
      for (const it of items) {
        const sid = it.song?.id
        const key = sid ? songKeys[sid] : null
        if (!key) continue
        const desired =
          key.mode === targetMode
            ? targetSemi
            : targetMode === 'minor'
              ? targetSemi + 3
              : targetSemi - 3
        const capo = Number(it.capo) || 0
        const shift = normalizeShift(signedDelta(desired - key.root) + capo)
        updates.push(updateListSongTone(id, sid, { shift, capo }))
      }
      await Promise.all(updates)
      await load()
      setToneOpen(false)
      setNotice(`Cifras padronizadas em ${targetKeyName}.`)
    } catch (e) {
      setToneNotice(e?.message || 'Não foi possível padronizar o tom.')
    } finally {
      setToneBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head row-space">
        <div className="grow">
          {editing && !readOnly ? (
            <div className="row">
              <input className="grow" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary sm-btn" onClick={saveName}>Salvar</button>
            </div>
          ) : (
            <h1 onClick={() => { if (!readOnly) { setName(list.name); setEditing(true) } }}>{list.name}</h1>
          )}
          <p className="muted">
            {items.length} {items.length === 1 ? 'música' : 'músicas'}
            {readOnly ? ' · somente leitura' : ''}
          </p>
          {readOnly && (
            <p className="muted small">
              Lista compartilhada: você só pode ajustar o tom das cifras.
            </p>
          )}
        </div>
        {!readOnly && (
          <div className="row wrap">
            <button
              className="icon-btn"
              onClick={() => { setShareMsg(''); setShareOpen(true) }}
              aria-label="Compartilhar lista"
            >
              <Icon name="share" size={18} />
            </button>
            <button
              className="icon-btn"
              onClick={() => { setSearchOpen(true); setQ(''); setHits([]); setNotice('') }}
              aria-label="Adicionar música"
            >
              <Icon name="plus" size={18} />
            </button>
            <button
              className="icon-btn"
              onClick={openStandardize}
              aria-label="Padronizar o tom das cifras"
              title="Padronizar o tom das cifras"
            >
              <Icon name="sliders" size={18} />
            </button>
            <button className="icon-btn" onClick={() => { setName(list.name); setEditing(true) }} aria-label="Renomear lista">
              <Icon name="edit" size={18} />
            </button>
          </div>
        )}
      </header>

      {notice && <p className="form-notice">{notice}</p>}

      <div className="stack">
        {items.length === 0 && (
          <div className="empty-state">
            <Icon name="list" size={34} />
            <p className="muted">Lista vazia. Toque no + para buscar e adicionar.</p>
          </div>
        )}
        {items.map((item, idx) => (
          <div key={item.id} className="setlist-row">
            <span className="setlist-index">{idx + 1}</span>
            <button type="button" className="song-card grow" onClick={() => item.song?.id && setOpenSongId(item.song.id)}>
              <div className="song-card-art small">
                {item.song?.image_url ? (
                  <img src={item.song.image_url} alt="" loading="lazy" />
                ) : (
                  <span className="song-card-art-letter">{(item.song?.artist || '?')[0]?.toUpperCase()}</span>
                )}
              </div>
              <div className="song-card-body">
                <strong className="song-card-title">{item.song?.title}</strong>
                <span className="song-card-artist">{item.song?.artist}</span>
                {(item.shift || item.capo) ? (
                  <span className="muted small">
                    {item.shift ? `Tom ${item.shift > 0 ? `+${item.shift}` : item.shift}` : ''}
                    {item.shift && item.capo ? ' · ' : ''}
                    {item.capo ? `Capo ${item.capo}` : ''}
                  </span>
                ) : null}
              </div>
            </button>
            {!readOnly && (
              <div className="row-actions">
                <button className="icon-btn sm" disabled={idx === 0} onClick={() => move(item, -1)} aria-label="Subir">
                  <Icon name="up" size={16} />
                </button>
                <button
                  className="icon-btn sm"
                  disabled={idx === items.length - 1}
                  onClick={() => move(item, 1)}
                  aria-label="Descer"
                >
                  <Icon name="down" size={16} />
                </button>
                <button className="icon-btn sm" onClick={() => remove(item)} aria-label="Remover da lista">
                  <Icon name="trash" size={16} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {chatToken ? (
        <ListChat token={chatToken} items={items} onOpenSong={setOpenSongId} />
      ) : !readOnly ? (
        <section className="chat">
          <button
            type="button"
            className="chat-head"
            onClick={() => { setShareMsg(''); setShareOpen(true) }}
          >
            <Icon name="chat" size={18} />
            <span className="grow">Recados da equipe</span>
            <span className="muted small">ative o link de leitura</span>
          </button>
        </section>
      ) : null}

      {openSongId && (
        <div className="song-modal" role="dialog" aria-modal="true">
          <SongView
            key={openSongId}
            songId={openSongId}
            listId={id}
            playlistIds={items.map((it) => it.song?.id).filter(Boolean)}
            onBack={() => { setOpenSongId(null); load() }}
            onReplaceSong={setOpenSongId}
            embedded
          />
        </div>
      )}

      {shareOpen && (
        <div className="sheet-backdrop" onClick={() => setShareOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Compartilhar lista</h3>
            {list.share_token && list.is_public ? (
              <>
                <p className="muted small">
                  Quem entrar com a conta verá esta lista em modo leitura. Você continua sendo o único que edita.
                </p>
                <div className="row">
                  <input
                    className="grow"
                    readOnly
                    value={shareUrlFor(list.share_token)}
                    onFocus={(e) => e.target.select()}
                  />
                  <button className="btn btn-primary sm-btn" onClick={copyShare}>Copiar</button>
                </div>
                {shareMsg && <p className="form-notice">{shareMsg}</p>}
                <button className="btn ghost" onClick={disableShare} disabled={shareBusy}>
                  {shareBusy ? 'Aguarde...' : 'Desativar link'}
                </button>
              </>
            ) : (
              <>
                <p className="muted small">
                  Crie um link de leitura para enviar a quem quiser. As músicas ficam sincronizadas e só você pode
                  editar a lista.
                </p>
                {shareMsg && <p className="form-notice">{shareMsg}</p>}
                <button className="btn btn-primary" onClick={enableShare} disabled={shareBusy}>
                  {shareBusy ? 'Criando...' : 'Criar link de leitura'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {toneOpen && (
        <div className="sheet-backdrop" onClick={() => { if (!toneBusy) setToneOpen(false) }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Padronizar o tom</h3>
            <p className="muted small">
              Escolha o tom da lista. As músicas maiores vão para o tom escolhido e as menores para o relativo
              (ex.: E vai para C#m). O capotraste de cada cifra é mantido.
            </p>
            {toneBusy && !Object.keys(songKeys).length ? (
              <p className="muted small">Analisando as cifras...</p>
            ) : Object.keys(songKeys).length ? (
              <>
                <p className="muted small">Maior</p>
                <div className="key-grid">
                  {MAJOR_KEYS.map((k) => (
                    <button key={k} className="key-btn" disabled={toneBusy} onClick={() => applyStandardTone(k)}>
                      {k}
                    </button>
                  ))}
                </div>
                <p className="muted small">Menor</p>
                <div className="key-grid">
                  {MINOR_KEYS.map((k) => (
                    <button key={k} className="key-btn" disabled={toneBusy} onClick={() => applyStandardTone(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted small">{toneNotice || 'Não conseguimos analisar as cifras desta lista.'}</p>
            )}
            {toneNotice && Object.keys(songKeys).length > 0 && <p className="form-notice">{toneNotice}</p>}
            <button className="btn ghost" onClick={() => setToneOpen(false)} disabled={toneBusy}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="sheet-backdrop" onClick={() => setSearchOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Adicionar à lista</h3>
            <div className="search-row">
              <Icon name="search" size={18} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Busque pelo nome da música"
                autoFocus
                autoComplete="off"
              />
            </div>
            {notice && <p className="form-error">{notice}</p>}
            {busy && <p className="muted small">Adicionando...</p>}
            <div className="sheet-list">
              {hits.map((s) => {
                const key = hitKey(s)
                const already = addedKeys.includes(key) || items.some((it) => it.song?.id === s.id)
                return (
                  <SongCard
                    key={key}
                    song={s}
                    onOpen={already || busy ? () => {} : addHit}
                    trailing={
                      already ? (
                        <span className="chip ok">Na lista</span>
                      ) : (
                        <span className="btn ghost icon-only" aria-hidden="true">
                          <Icon name="plus" size={18} />
                        </span>
                      )
                    }
                  />
                )
              })}
              {q.trim() && hits.length === 0 && !busy && (
                <p className="muted">Nenhuma cifra encontrada.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
