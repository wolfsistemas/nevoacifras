import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icons'
import { getLists, createList, deleteList } from '../lib/store'
import { useAuth } from '../hooks/useAuth'

export default function Lists() {
  const nav = useNavigate()
  const { user } = useAuth()
  const [lists, setLists] = useState(null)
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)

  const load = () => getLists().then(setLists)

  useEffect(() => {
    if (user) load()
  }, [user])

  const create = async () => {
    const n = name.trim()
    if (!n) return
    await createList(n)
    setName('')
    setOpen(false)
    load()
  }

  const remove = async (id, e) => {
    e.stopPropagation()
    if (!window.confirm('Excluir esta lista?')) return
    await deleteList(id)
    load()
  }

  return (
    <div className="page">
      <header className="page-head row-space">
        <div className="grow">
          <h1>Minhas listas</h1>
          <p className="muted">Repertórios e setlists para ensaio e show.</p>
        </div>
        <button
          className="icon-btn"
          onClick={() => { setName(''); setOpen(true) }}
          aria-label="Criar lista"
        >
          <Icon name="plus" size={18} />
        </button>
      </header>

      <div className="stack">
        {lists === null && <p className="muted">Carregando...</p>}
        {lists && lists.length === 0 && (
          <div className="empty-state">
            <Icon name="list" size={34} />
            <p className="muted">Nenhuma lista ainda. Toque no + para criar a primeira.</p>
          </div>
        )}
        {lists?.map((l) => (
          <div key={l.id} className="list-card" role="button" tabIndex={0} onClick={() => nav(`/lists/${l.id}`)}>
            <span className="list-card-body">
              <strong>{l.name}</strong>
              <span className="muted small">
                {l.count} {l.count === 1 ? 'música' : 'músicas'}
              </span>
            </span>
            <span className="row">
              <Icon name="play" size={18} className="ghost-icon" />
              <button
                className="icon-btn sm"
                onClick={(e) => remove(l.id, e)}
                aria-label="Excluir lista"
              >
                <Icon name="trash" size={16} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3 className="sheet-title">Nova lista</h3>
            <div className="search-row">
              <Icon name="list" size={18} />
              <input
                value={name}
                autoFocus
                placeholder="Nome da lista (ex: Acústico sexta)"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
              />
            </div>
            <button className="btn btn-primary sheet-submit" onClick={create} disabled={!name.trim()}>
              Criar lista
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
