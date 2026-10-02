import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../components/Icons'
import { SongView } from './Song'
import { getSharedList } from '../lib/store'

export default function SharedList() {
  const { token } = useParams()
  const nav = useNavigate()
  const [list, setList] = useState(null)
  const [status, setStatus] = useState('loading')
  const [openSongId, setOpenSongId] = useState(null)
  const toneScope = `share-${token}`

  const load = () => {
    getSharedList(token, toneScope)
      .then((l) => {
        setList(l)
        setStatus(l ? 'ok' : 'missing')
      })
      .catch(() => setStatus('error'))
  }

  useEffect(() => {
    load()
  }, [token])

  if (status === 'loading') return <div className="page center-page">Carregando...</div>

  if (status !== 'ok' || !list) {
    return (
      <div className="page">
        <div className="empty-state">
          <Icon name="link" size={34} />
          <p className="muted">Este link não está disponível. O compartilhamento pode ter sido desativado.</p>
          <button className="btn ghost" onClick={() => nav('/lists')}>Ver minhas listas</button>
        </div>
      </div>
    )
  }

  const items = list.items || []

  return (
    <div className="page">
      <header className="page-head">
        <span className="chip">Lista compartilhada</span>
        <h1>{list.name}</h1>
        <p className="muted">
          {items.length} {items.length === 1 ? 'música' : 'músicas'} · somente leitura
        </p>
      </header>

      <div className="stack">
        {items.length === 0 && (
          <div className="empty-state">
            <Icon name="list" size={34} />
            <p className="muted">Esta lista ainda está vazia.</p>
          </div>
        )}
        {items.map((item, idx) => (
          <div
            key={item.id}
            className="list-card"
            role="button"
            tabIndex={0}
            onClick={() => item.song?.id && setOpenSongId(item.song.id)}
          >
            <span className="setlist-index">{idx + 1}</span>
            <span className="list-card-body grow">
              <strong className="song-card-title">{item.song?.title}</strong>
              <span className="song-card-artist">{item.song?.artist}</span>
              {item.shift || item.capo ? (
                <span className="muted small">
                  {item.shift ? `Tom ${item.shift > 0 ? `+${item.shift}` : item.shift}` : ''}
                  {item.shift && item.capo ? ' · ' : ''}
                  {item.capo ? `Capo ${item.capo}` : ''}
                </span>
              ) : null}
            </span>
            <Icon name="play" size={18} className="ghost-icon" />
          </div>
        ))}
      </div>

      <p className="muted small">O tom que você ajusta fica salvo só para você e não altera a lista do dono.</p>

      {openSongId && (
        <div className="song-modal" role="dialog" aria-modal="true">
          <SongView
            key={openSongId}
            songId={openSongId}
            listId={toneScope}
            playlistIds={items.map((it) => it.song?.id).filter(Boolean)}
            onBack={() => { setOpenSongId(null); load() }}
            onReplaceSong={setOpenSongId}
            localToneOnly
            embedded
          />
        </div>
      )}
    </div>
  )
}
