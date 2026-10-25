/* Only public card pictures and the rulebook belong here. Never cache pages,
 * account APIs, match snapshots, JS bundles or websocket traffic. */
const CACHE_NAME = 'thunderstone-public-assets-v1';
const RECHECK_MS = 60_000;
const checked = new Map();
const pending = new Map();

function assetUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return null;
    if (!/^\/cards\/(?:TS-\d{4}\.png|TS-BACK-001\.jpg)$/.test(url.pathname)
        && url.pathname !== '/rulebooks/TS4_rules_CN.pdf') return null;
    // These fixed public routes do not use query parameters for identity.
    return url.origin + url.pathname;
  } catch {return null;}
}

function cacheable(response, url) {
  const type = response.headers.get('content-type')?.split(';')[0];
  return response.status === 200 && !response.redirected
    && !/no-store|private/i.test(response.headers.get('cache-control') ?? '')
    && type === (url.endsWith('.pdf') ? 'application/pdf' : url.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
}

function refresh(url, cache, cached) {
  if (!pending.has(url)) {
    checked.set(url, Date.now());
    const request = (async () => {
      const headers = new Headers();
      if (cached?.headers.get('etag')) headers.set('If-None-Match', cached.headers.get('etag'));
      else if (cached?.headers.get('last-modified')) headers.set('If-Modified-Since', cached.headers.get('last-modified'));
      try {
        // Fetch a full representation even if the PDF viewer asked for bytes.
        // CacheStorage must never mistake a 206 fragment for the whole file.
        const response = await fetch(url, {headers, credentials: 'omit', cache: 'no-cache'});
        if (response.status === 304 && cached) return cached;
        if (cacheable(response, url)) {
          try {await cache.put(url, response.clone());} catch { /* Quota/private mode: viewing still works. */ }
          return response;
        }
        if (response.status === 404 || response.status === 410) {
          try {await cache.delete(url);} catch { /* Optional storage. */ }
          return response;
        }
        return cached ?? response;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    })().finally(() => pending.delete(url));
    pending.set(url, request);
  }
  // Several card elements, full-size inspection and parallel PDF byte requests can
  // share a download, but each consumer needs its own readable response body.
  return pending.get(url).then(response => response.clone());
}

async function byteRange(request, response) {
  const range = request.headers.get('range');
  if (!range || response.status !== 200) return response;
  const ifRange = request.headers.get('if-range');
  if (ifRange && (ifRange.startsWith('W/') || (ifRange !== response.headers.get('etag') && ifRange !== response.headers.get('last-modified')))) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  // A server may ignore unsupported/multiple ranges and send the full file.
  if (!match || (!match[1] && !match[2])) return response;
  const body = await response.blob(), size = body.size;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, {status: 416, headers});
  }
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), {status: 206, headers});
}

async function resource(request, url, defer) {
  let cache, cached;
  try {cache = await caches.open(CACHE_NAME); cached = await cache.match(url);}
  catch {return fetch(request);}
  const due = !checked.has(url) || Date.now() - checked.get(url) >= RECHECK_MS;
  const reload = request.cache === 'reload' || request.cache === 'no-cache';
  let response = cached;
  if (!cached || reload || (url.endsWith('.pdf') && (due || pending.has(url)))) {
    // Revalidate a PDF before opening it so a viewer sees a consistent version.
    response = await refresh(url, cache, cached);
  } else if (due) {
    // Pictures paint immediately from disk. A changed picture is replaced in
    // the cache for its next display; an unchanged picture only costs a 304.
    defer(refresh(url, cache, cached).then(() => {}));
  }
  return byteRange(request, response);
}

self.addEventListener('install', event => {event.waitUntil(self.skipWaiting());});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith('thunderstone-public-assets-v') && name !== CACHE_NAME).map(name => caches.delete(name)));
    } catch { /* Cache storage may be unavailable; leave ordinary fetching usable. */ }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = assetUrl(request.url);
  if (!url || request.method !== 'GET' || request.headers.has('authorization')) return;
  const background = [];
  const response = resource(request, url, work => background.push(work));
  event.respondWith(response);
  event.waitUntil(response.then(() => Promise.all(background)).catch(() => {}));
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_LOADED_ASSETS' || !Array.isArray(event.data.urls)) return;
  // First installation may claim a page after its images have already loaded.
  // Warm only those actual resources, using the ordinary HTTP cache as well.
  const urls = [...new Set(event.data.urls.map(assetUrl).filter(Boolean))];
  event.waitUntil((async () => {
    let cache;
    try {cache = await caches.open(CACHE_NAME);} catch {return;}
    for (const url of urls) {
      try {if (!await cache.match(url)) await refresh(url, cache);} catch { /* Do not disrupt the page on a failed warmup. */ }
    }
  })());
});
