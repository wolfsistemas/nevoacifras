import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icons'
import { useAuth } from '../hooks/useAuth'
import { useOnline } from '../hooks/useOnline'
import { supabase } from '../lib/supabase'
import { listMessages, sendListMessage, deleteListMessage } from '../lib/store'
import {
  enablePush,
  disablePush,
  getPushState,
  getSeenAt,
  markSeen,
  isIOS,
  isStandalone
} from '../lib/push'

function formatTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + time
}

function namesLabel(names) {
  if (names.length === 1) return names[0] + ' está digitando'
  if (names.length === 2) return names[0] + ' e ' + names[1] + ' estão digitando'
  return 'Várias pessoas estão digitando'
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
  const [typers, setTypers] = useState({})
  const [seenAt, setSeenAt] = useState(() => (token ? getSeenAt(token) : ''))
  const [pushState, setPushState] = useState('loading')
  const [pushBusy, setPushBusy] = useState(false)
  const [pushHint, setPushHint] = useState('')
  const endRef = useRef(null)
  const channelRef = useRef(null)
  const meRef = useRef({ id: null, username: 'Membro' })
  const lastTypingRef = useRef(0)

  useEffect(() => {
    meRef.current = { id: user?.id || null, username: profile?.username || 'Membro' }
  }, [user, profile])

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
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'list_messages', filter: `share_token=eq.${token}` },
        (payload) => {
          const id = payload.old?.id
          if (id) setMessages((prev) => prev.filter((m) => m.id !== id))
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (!payload || !payload.userId || payload.userId === meRef.current.id) return
        setTypers((prev) => ({
          ...prev,
          [payload.userId]: { username: payload.username || 'Alguém', at: Date.now() }
        }))
      })
      .subscribe()
    channelRef.current = channel
    return () => {
      active = false
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [token])

  // limpa quem parou de digitar
  useEffect(() => {
    const t = setInterval(() => {
      setTypers((prev) => {
        const now = Date.now()
        const next = {}
        let changed = false
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.at < 3500) next[k] = v
          else changed = true
        }
        return changed ? next : prev
      })
    }, 1500)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (open && endRef.current) endRef.current.scrollIntoView({ block: 'nearest' })
  }, [messages, open])

  useEffect(() => {
    if (!token) return
    let active = true
    getPushState().then((s) => {
      if (active) setPushState(s)
    })
    return () => {
      active = false
    }
  }, [token])

  // Marca os recados como lidos enquanto a conversa está aberta.
  useEffect(() => {
    if (!open || !token) return
    const lastAt = messages.reduce((acc, m) => (m.created_at > acc ? m.created_at : acc), '')
    const value = lastAt || new Date().toISOString()
    if (value !== seenAt) {
      markSeen(token, value)
      setSeenAt(value)
    }
  }, [open, messages, token, seenAt])

  const notifyTyping = () => {
    const ch = channelRef.current
    const me = meRef.current
    if (!ch || !me.id) return
    const now = Date.now()
    if (now - lastTypingRef.current < 1500) return
    lastTypingRef.current = now
    try {
      ch.send({ type: 'broadcast', event: 'typing', payload: { userId: me.id, username: me.username } })
    } catch {}
  }

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
      setTypers({})
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

  const typingNames = Object.values(typers).map((t) => t.username).filter(Boolean)
  const unreadCount = messages.filter(
    (m) => m.created_at > seenAt && (!user || m.user_id !== user.id)
  ).length

  const togglePush = async () => {
    if (pushBusy) return
    setPushBusy(true)
    setPushHint('')
    setError('')
    try {
      if (pushState === 'on') {
        await disablePush(token)
        setPushState('off')
        setPushHint('Notificações desativadas neste aparelho.')
      } else {
        await enablePush(token)
        setPushState('on')
        setPushHint('Pronto! Você será avisado de novos recados.')
      }
    } catch (e) {
      setPushHint(e?.message || 'Não foi possível ativar agora.')
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <section className="chat">
      <button type="button" className="chat-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="chat" size={18} />
        <span className="grow">Recados da equipe</span>
        {unreadCount > 0 && <span className="chat-count">{unreadCount}</span>}
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
          {typingNames.length > 0 && (
            <p className="chat-typing">
              {namesLabel(typingNames)}
              <span className="chat-dots"><i /><i /><i /></span>
            </p>
          )}
          {!online && (
            <p className="muted small">
              Você está offline: dá para ler os recados salvos, mas enviar precisa de conexão.
            </p>
          )}

          <div className="chat-push">
            {pushState === 'unsupported' ? (
              <span className="muted small">
                {isIOS() && !isStandalone()
                  ? 'No iPhone, adicione o app à Tela de Início para receber notificações.'
                  : 'Este navegador não aceita notificações.'}
              </span>
            ) : pushState === 'denied' ? (
              <span className="muted small">Notificações bloqueadas no navegador.</span>
            ) : (
              <button
                type="button"
                className={pushState === 'on' ? 'btn ghost sm-btn on-soft' : 'btn ghost sm-btn'}
                onClick={togglePush}
                disabled={pushBusy || !online}
              >
                <Icon name="bell" size={15} />
                {pushState === 'on' ? 'Notificações ativas' : 'Ativar notificações'}
              </button>
            )}
            {pushHint && <span className="muted small">{pushHint}</span>}
          </div>

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
                onChange={(e) => {
                  setText(e.target.value)
                  notifyTyping()
                }}
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
