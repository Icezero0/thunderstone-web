/** Optional persistent caching for public media; game/network state is unaffected. */
if (window.isSecureContext && 'serviceWorker' in navigator) {
  const workers = navigator.serviceWorker;
  const initiallyControlled = !!workers.controller;
  let warmed = false;
  const warmLoaded = (worker = workers.controller) => {
    if (!worker || warmed || initiallyControlled) return;
    warmed = true;
    const urls = [...document.images].map(image => image.currentSrc || image.src);
    urls.push(...performance.getEntriesByType('resource').map(entry => entry.name));
    worker.postMessage({type: 'CACHE_LOADED_ASSETS', urls: [...new Set(urls)]});
  };
  workers.addEventListener('controllerchange', () => warmLoaded(), {once: true});
  void workers.register('/asset-cache-sw.js', {scope: '/', updateViaCache: 'none'})
    .then(() => workers.ready).then(registration => warmLoaded(registration.active))
    .catch(() => { /* Unsupported/private environments retain conditional HTTP caching. */ });
}

export {};
