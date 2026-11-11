// 부동산신탁 관계법령 서비스 워커 — 한 번 열면 인터넷 없이도 열리도록 저장합니다.
const SHELL = 'bd-shell-v3';
const DATA = 'bd-data-v1';
const SHELL_FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 목록을 새로 받으면 모든 법령 본문을 미리 저장(오프라인 대비)하고, 옛 버전은 지웁니다.
async function warm(index) {
  const c = await caches.open(DATA);
  const want = new Set(index.laws.map((l) => new URL(`data/laws/${l.id}.json?m=${l.mst}`, self.registration.scope).href));
  for (const req of await c.keys()) {
    if (req.url.includes('/data/laws/') && !want.has(req.url)) await c.delete(req);
  }
  for (const u of want) {
    if (await c.match(u)) continue;
    try { const r = await fetch(u); if (r.ok) await c.put(u, r); } catch {}
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 글꼴 등 외부는 브라우저에 맡김

  // 목록·개정내역: 인터넷 먼저, 안 되면 저장본
  if (/\/data\/(index|changes)\.json$/.test(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const r = await fetch(req, { cache: 'no-cache' });
        if (r.ok) {
          await c.put(url.pathname, r.clone());
          if (url.pathname.endsWith('index.json')) r.clone().json().then((j) => warm(j)).catch(() => {});
        }
        return r;
      } catch { return (await c.match(url.pathname)) || Response.error(); }
    })());
    return;
  }
  // 법령 본문: 저장본 먼저(버전이 주소에 들어 있음)
  if (url.pathname.includes('/data/laws/')) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    })());
    return;
  }
  // 앱 화면: 인터넷 먼저(최신 화면), 안 되면 저장본
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    try {
      const r = await fetch(req);
      if (r.ok && !url.pathname.endsWith('offline.html')) c.put(req, r.clone());
      return r;
    } catch {
      return (await c.match(req)) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
    }
  })());
});
