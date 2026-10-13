// idea-loom 的 service worker：让它能装到主屏幕，并接收推送通知。
// 它不缓存任何东西：页面和数据永远从网络取，这样不会有人看到过期的想法池。
//
// The idea-loom service worker: it makes the app installable and receives push
// notifications. It caches nothing: pages and data always come from the network, so nobody
// ever sees a stale idea pool.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// 有这个监听器浏览器才认为它"可安装"；这里什么都不改，直接放行。
// The browser only treats the app as installable when this listener exists; nothing is changed here, requests pass straight through.
self.addEventListener('fetch', () => {})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: '想法经纬', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || '想法经纬', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  )
})

// 点通知：已经开着就切过去并跳到那一页，没开就开一个。
// Tapping a notification: focus the open window and go to that page, or open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          w.navigate(url)
          return w.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
