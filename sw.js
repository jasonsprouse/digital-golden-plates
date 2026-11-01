const CACHE_NAME = 'gfp-golden-plates-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './nft_harps_presentation.html',
  './harps_inline_widget.html',
  './prismatic_architecture.html',
  './basket_pwa.js',
  './manifest.json',
  './assets/asset_g_harps_front.jpg',
  './assets/asset_harps_of_god_both.jpg',
  './assets/asset_y_harps_front.jpg',
  './assets/asset_y_harps_back.jpg',
  './assets/card_yellow_y_harps_492856_front.jpg',
  './assets/card_yellow_y_harps_492856_back.jpg',
  './assets/card_green_g_harps_490643_front.jpg',
  './assets/card_green_g_harps_490643_back.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for HTML/JS; Cache-first with background refresh for images & Google TTS MP3 audio
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Skip caching 69MB video stream to avoid quota issues
  if (url.pathname.endsWith('.mp4')) return;

  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// IndexedDB helper inside Service Worker for Background Sync & Order Queue Verification
function openCommerceDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('GFP_Harps_Commerce_DB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('basket_items')) {
        db.createObjectStore('basket_items', { keyPath: 'sku' });
      }
      if (!db.objectStoreNames.contains('checkout_orders')) {
        db.createObjectStore('checkout_orders', { keyPath: 'orderId' });
      }
      if (!db.objectStoreNames.contains('engagement_state')) {
        db.createObjectStore('engagement_state', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function syncPendingOrders() {
  const db = await openCommerceDB();
  const tx = db.transaction('checkout_orders', 'readwrite');
  const store = tx.objectStore('checkout_orders');
  const allReq = store.getAll();
  return new Promise((resolve) => {
    allReq.onsuccess = async () => {
      const orders = allReq.result || [];
      let syncedCount = 0;
      for (const ord of orders) {
        if (ord.syncStatus === 'QUEUED_OFFLINE') {
          ord.syncStatus = 'VERIFIED_BY_SW';
          ord.swVerifiedAt = new Date().toISOString();
          store.put(ord);
          syncedCount++;
        }
      }
      const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const client of clientsList) {
        client.postMessage({
          type: 'SW_ORDERS_SYNCED',
          syncedCount,
          totalOrders: orders.length,
          timestamp: new Date().toISOString()
        });
      }
      resolve(syncedCount);
    };
    allReq.onerror = () => resolve(0);
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'gfp-checkout-sync') {
    event.waitUntil(syncPendingOrders());
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PING_SW') {
    event.source.postMessage({
      type: 'PONG_SW',
      cacheVersion: CACHE_NAME,
      status: 'ACTIVE',
      timestamp: new Date().toISOString()
    });
  } else if (data.type === 'BROADCAST_BASKET_UPDATE') {
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.id !== event.source.id) {
          client.postMessage({ type: 'BASKET_UPDATED_FROM_SW', payload: data.payload });
        }
      }
    });
  } else if (data.type === 'TRIGGER_ORDER_SYNC') {
    syncPendingOrders();
  }
});
