/** Preserve the existing tools' URLs and query strings on Vite's multi-page server. */
export const pageFiles = {
  '/': 'index.html', '/play': 'index.html', '/config': 'config.html',
  '/effect-lab': 'effect-lab.html', '/match': 'match.html', '/game-probe': 'game-probe.html',
  '/profile': 'profile.html',
};

export function rewritePageUrl(url = '/') {
  const question = url.indexOf('?');
  const pathname = question < 0 ? url : url.slice(0, question);
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const file = pageFiles[normalized];
  return file ? `/${file}${question < 0 ? '' : url.slice(question)}` : url;
}
