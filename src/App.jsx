import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { NavLink } from 'react-router-dom'
import { Icon } from './components/Icons'
import { useAuth } from './hooks/useAuth'
import Home from './pages/Home'
import Song from './pages/Song'
import Lists from './pages/Lists'
import ListDetail from './pages/ListDetail'
import SharedList from './pages/SharedList'
import Favorites from './pages/Favorites'
import Tuner from './pages/Tuner'
import AuthPage from './pages/AuthPage'
import Profile from './pages/Profile'
import Chords from './pages/Chords'

const NAV = [
  { to: '/', icon: 'home', label: 'Início', end: true },
  { to: '/lists', icon: 'list', label: 'Listas' },
  { to: '/favorites', icon: 'heart', label: 'Favoritos' },
  { to: '/tuner', icon: 'tuner', label: 'Afinador' },
  { to: '/me', icon: 'user', label: 'Conta' }
]

function Layout() {
  const loc = useLocation()
  const isSong = loc.pathname.startsWith('/song/')
  return (
    <div className={isSong ? 'app app-song' : 'app'}>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/song/:songId/:version?" element={<Song />} />
          <Route path="/lists" element={<RequireAuth><Lists /></RequireAuth>} />
          <Route path="/lists/:id" element={<RequireAuth><ListDetail /></RequireAuth>} />
          <Route path="/share/:token" element={<RequireAuth><SharedList /></RequireAuth>} />
          <Route path="/favorites" element={<RequireAuth><Favorites /></RequireAuth>} />
          <Route path="/tuner" element={<Tuner />} />
          <Route path="/chords" element={<Chords />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/me" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!isSong && (
        <nav className="bottom-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <Icon name={n.icon} size={22} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <div className="page center-page">Carregando...</div>
  if (!user) {
    const next = encodeURIComponent(`${loc.pathname}${loc.search}`)
    return <Navigate to={`/auth?next=${next}`} replace />
  }
  return children
}

export default function App() {
  return <Layout />
}
