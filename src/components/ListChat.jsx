import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icons'
import { useAuth } from '../hooks/useAuth'
import { useOnline } from '../hooks/useOnline'
import { supabase } from '../lib/supabase'
import { listMessages, sendListMessage, deleteListMessage } from '../lib/store'

function formatTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + time
}

export default function ListChat({ token, items = [], onOpenSong }) {
  const { user, profile } = useAuth()
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [songId, setSongId] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef(null)

  const songsById = useMemo(() => {
    const map = new Map()
    for (const it of items) if (it.song?.id) map.set(it.song.id, it.song)
    return map
  }, [items])

  useEffect(() => {
    if (!token) return
    let active = true
    listMessages(token)
      .then((rows) => {
        if (active) {
          setMessages(rows)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (active) setLoaded(true)
      })
    const channel = supabase
      .channel('list-chat-' + token)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'list_messages', filter: `share_token=eq.${token}` },
        (payload) => {
          const msg = payload.new
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
        }
      )
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [token])

  useEffect(() => {
    if (open && endRef.current) endRef.current.scrollIntoView({ block: 'nearest' })
  }, [messages, open])

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setError('')
    try {
      const saved = await sendListMessage({
        token,
        body,
        songId: songId || null,
        username: profile?.username || 'Membro'
      })
      if (saved) {
        setMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]))
      }
      setText('')
      setSongId('')
    } catch (e) {
      setError(e?.message || 'Não foi possível enviar agora.')
    } finally {
      setSending(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm('Apagar este recado?')) return
    try {
      await deleteListMessage(id)
      setMessages((prev) => prev.filter((m) => m.id !== id))
    } catch (e) {
      setError(e?.message || 'Não foi possível apagar.')
    }
  }

  if (!token) return null

  return (
    <section className="chat">
      <button type="button" className="chat-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="chat" size={18} />
        <span className="grow">Recados da equipe</span>
        {messages.length > 0 && <span className="chat-count">{messages.length}</span>}
        <Icon name={open ? 'up' : 'down'} size={16} />
      </button>

      {open && (
        <div className="chat-panel">
          <div className="chat-list">
            {!loaded && <p className="muted small">Carregando recados...</p>}
            {loaded && messages.length === 0 && (
              <p className="muted small">Nenhum recado ainda. Comece a conversa com a equipe.</p>
            )}
            {messages.map((m) => {
              const mine = user && m.user_id === user.id
              const song = m.song_id ? songsById.get(m.song_id) : null
              return (
                <div key={m.id} className={mine ? 'chat-msg mine' : 'chat-msg'}>
                  <div className="chat-meta">
                    <strong>{mine ? 'Você' : m.username || 'Membro'}</strong>
                    <span>{formatTime(m.created_at)}</span>
                    {mine && (
                      <button className="chat-del" onClick={() => remove(m.id)} aria-label="Apagar recado">
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                  <div className="chat-body">{m.body}</div>
                  {m.song_id && (
                    <button
                      type="button"
                      className="chat-song"
                      onClick={() => song && onOpenSong && onOpenSong(song.id)}
                      disabled={!song || !onOpenSong}
                    >
                      <Icon name="music" size={14} />
                      {song ? `${song.title} — ${song.artist}` : 'Música'}
                    </button>
                  )}
                </div>
              )
            })}
            <div ref={endRef} />
          </div>

          {error && <p className="form-error">{error}</p>}
          {!online && (
            <p className="muted small">
              Você está offline: dá para ler os recados salvos, mas enviar precisa de conexão.
            </p>
          )}

          <div className="chat-composer">
            {items.length > 0 && (
              <select className="chat-select" value={songId} onChange={(e) => setSongId(e.target.value)}>
                <option value="">Sem música</option>
                {items
                  .filter((it) => it.song?.id)
                  .map((it) => (
                    <option key={it.song.id} value={it.song.id}>
                      {it.song.title} — {it.song.artist}
                    </option>
                  ))}
              </select>
            )}
            <div className="row">
              <input
                className="grow"
                value={text}
                maxLength={2000}
                placeholder="Escreva um recado..."
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button
                className="icon-btn"
                onClick={send}
                disabled={sending || !text.trim() || !online}
                aria-label="Enviar recado"
              >
                <Icon name="send" size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
