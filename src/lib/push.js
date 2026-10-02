import { supabase } from './supabase'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''
const SEEN_PREFIX = 'nevoa_chat_seen_'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    !!VAPID_PUBLIC
  )
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function isStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null
  try {
    return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready)
  } catch {
    return null
  }
}

export async function getPushState() {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return sub ? 'on' : 'off'
}

export async function enablePush(token) {
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) {
      throw new Error('No iPhone, adicione o app à Tela de Início para ativar as notificações.')
    }
    throw new Error('Este navegador não aceita notificações.')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Permissão de notificação não concedida.')
  }
  const reg = await getRegistration()
  if (!reg) throw new Error('Serviço de notificações indisponível.')

  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    })
  }
  const json = sub.toJSON()
  await supabase.from('push_subscriptions').delete().eq('endpoint', json.endpoint).eq('share_token', token)
  const { error } = await supabase.from('push_subscriptions').insert({
    share_token: token,
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth
  })
  if (error) throw error
  return true
}

export async function disablePush(token) {
  const reg = await getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  if (!sub) return
  const endpoint = sub.endpoint
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('share_token', token)
  const { data } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', endpoint)
    .limit(1)
  if (!data || data.length === 0) {
    try {
      await sub.unsubscribe()
    } catch {}
  }
}

function seenKey(token) {
  return SEEN_PREFIX + token
}

export function getSeenAt(token) {
  try {
    return localStorage.getItem(seenKey(token)) || ''
  } catch {
    return ''
  }
}

export function markSeen(token, iso) {
  if (!token) return
  const value = iso || new Date().toISOString()
  try {
    localStorage.setItem(seenKey(token), value)
  } catch {}
}
