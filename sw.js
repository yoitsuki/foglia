// foglia Service Worker
// 目的: 起動のたびに外部CDN(React/Babel/Tailwind/lucide/Fonts)へ
//       ネットワーク取得しに行く構造をやめ、一度取得したものをキャッシュして
//       オフライン/回線不安定時でも白画面にならず起動できるようにする。

// キャッシュを作り直したいときはこのバージョンを上げる
const CACHE = 'foglia-cache-v1';

// アプリ本体(シェル)。インストール時に先読みしておく。
const APP_SHELL = ['./', './index.html'];

// 起動に必須の外部CDN。ここからのGET取得はキャッシュ優先にする。
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'esm.sh',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', (event) => {
  // すぐ有効化する
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 1つ失敗しても install 全体を失敗させない
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 古いキャッシュを掃除
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET以外(GASへのPOST等)は一切触らずそのまま通す
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 画面遷移(HTML本体): ネット優先・失敗時はキャッシュ。
  // これで再デプロイ時の更新を拾いつつ、オフラインでも起動できる。
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached =
            (await caches.match(req)) ||
            (await caches.match('./index.html')) ||
            (await caches.match('./'));
          if (cached) return cached;
          throw e;
        }
      })()
    );
    return;
  }

  // 必須CDNアセット: キャッシュ優先。無ければ取得してキャッシュに入れる。
  // これにより2回目以降の起動はネット非依存になる。
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) {
          // バックグラウンドで静かに更新(stale-while-revalidate)
          event.waitUntil(updateCache(req));
          return cached;
        }
        try {
          const fresh = await fetch(req);
          // opaque(no-cors)含め、正常応答ならキャッシュ
          if (fresh && (fresh.ok || fresh.type === 'opaque')) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (e) {
          // 最後の砦としてキャッシュを再確認
          const fallback = await caches.match(req);
          if (fallback) return fallback;
          throw e;
        }
      })()
    );
  }
  // それ以外(同一オリジンの細かいリソース等)は既定の挙動に任せる
});

async function updateCache(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
      const cache = await caches.open(CACHE);
      await cache.put(req, fresh.clone());
    }
  } catch (e) {
    // 更新失敗は無視(キャッシュを使い続ける)
  }
}
