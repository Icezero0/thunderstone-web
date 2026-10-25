/** Public pages shared by the development and deployment builds. */
export const pageFiles = {
  '/': 'index.html', '/play': 'index.html', '/config': 'config.html',
  '/match': 'match.html', '/profile': 'profile.html',
  '/login': 'auth.html', '/register': 'auth.html',
};

/** These development resources must never be served, even by an existing Vite process. */
export function isPrivateResource(url = '/') {
  let path;
  try {path = decodeURIComponent(url.split('?')[0]).replaceAll('\\', '/').toLowerCase();}
  catch {return true;}
  return /(?:^|\/)(?:tests|\.test-dist|archive)(?:\/|$)/.test(path)
    || /(?:^|\/)(?:game-probe|effect-lab|monster-audit|setup-sandbox|battle-sandbox)(?:[/.]|$)/.test(path);
}

export function rewritePageUrl(url = '/') {
  const question = url.indexOf('?');
  const pathname = question < 0 ? url : url.slice(0, question);
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const file = pageFiles[normalized];
  return file ? `/${file}${question < 0 ? '' : url.slice(question)}` : url;
}
