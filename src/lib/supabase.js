import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  }
})

export function authRedirectUrl() {
  const url = new URL(window.location.href)
  let path = url.pathname.replace(/index\.html$/, '')
  if (!path.endsWith('/')) {
    const i = path.lastIndexOf('/')
    path = i >= 0 ? path.slice(0, i + 1) : '/'
  }
  return `${url.origin}${path || '/'}`
}

export const EDGE_FUNCTION_URL =
  import.meta.env.VITE_EDGE_FUNCTION_URL ||
  `${url}/functions/v1/smooth-function`

function friendlyError(status, data, fallback) {
  const msg = data?.error?.message || data?.message
  if (status === 404 || /not.?found|não encontr|nao encontr|indispon/i.test(msg || '')) {
    return 'Ainda não temos essa cifra no catálogo e o Cifra Club não liberou a busca automática agora. Tente de novo em alguns instantes ou escolha outra versão.'
  }
  if (status === 429 || status >= 500) {
    return 'O Cifra Club está limitando as buscas neste momento. Aguarde alguns segundos e tente novamente.'
  }
  return msg || fallback
}

export async function callFetchSong({ artist, title, ...extra }) {
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon}` },
    body: JSON.stringify({ artist, title, ...extra })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(friendlyError(res.status, data, 'Erro ao buscar a cifra.'))
  }
  return data
}

export async function callSearchSong(q) {
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon}` },
    body: JSON.stringify({ q, mode: 'search' })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(friendlyError(res.status, data, 'Não encontramos essa música.'))
  }
  return data
}
