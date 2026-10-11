// 推送通知的开和关。只有主人用：方案待批、作业结果、访客的愿望、队列暂停，会推到这台设备上。
// Turning push notifications on and off. For the owner only: plans waiting for approval, job
// results, visitors' wishes and queue pauses are pushed to this device.

export type PushState = 'unsupported' | 'unconfigured' | 'blocked' | 'off' | 'on'

type ServerState = { configured: boolean; public_key: string; devices: number }

const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function server(): Promise<ServerState | null> {
  try {
    const res = await fetch('/api/push')
    return res.ok ? ((await res.json()) as ServerState) : null
  } catch {
    return null
  }
}

const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  const state = await server()
  if (!state?.configured) return 'unconfigured'
  if (Notification.permission === 'denied') return 'blocked'
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ? 'on' : 'off'
}

export async function turnOn(): Promise<PushState> {
  const state = await server()
  if (!supported() || !state?.configured) return supported() ? 'unconfigured' : 'unsupported'
  if ((await Notification.requestPermission()) !== 'granted') return Notification.permission === 'denied' ? 'blocked' : 'off'
  const registration = await navigator.serviceWorker.ready
  const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.public_key) }))
  const res = await post('/api/push/subscribe', { subscription: subscription.toJSON() })
  if (!res.ok) return 'off'
  void post('/api/push/test', {})
  return 'on'
}

export async function turnOff(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription) {
    await post('/api/push/unsubscribe', { endpoint: subscription.endpoint })
    await subscription.unsubscribe()
  }
  return 'off'
}
