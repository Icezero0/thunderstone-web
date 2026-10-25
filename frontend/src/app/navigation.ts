/** Only known application routes may be used as login return paths. */
export function matchReturnPath(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://thunderstone.invalid');
    if (url.origin !== 'https://thunderstone.invalid' || url.pathname !== '/match') return null;
    const id = url.searchParams.get('id');
    if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
    return id ? `/match?id=${encodeURIComponent(id)}` : '/match';
  } catch {return null;}
}

export function matchLink(id: string): string {return `/match?id=${encodeURIComponent(id)}`;}
export function loginReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  const match = matchReturnPath(value); if (match) return match;
  try {
    const url = new URL(value, 'https://thunderstone.invalid');
    if (url.origin !== 'https://thunderstone.invalid') return null;
    if (url.pathname === '/profile') return '/profile';
    if (url.pathname === '/play' || url.pathname === '/') return url.searchParams.get('view') === 'room' ? '/play?view=room' : '/play';
    const room = url.searchParams.get('room');
    if (url.pathname === '/config' && room && /^[a-f0-9]{32}$/.test(room)) return `/config?room=${room}`;
  } catch { /* Invalid return paths fall back to the lobby. */ }
  return null;
}
export function loginLink(next: string | null = null): string {
  const path = loginReturnPath(next);
  return path ? `/login?next=${encodeURIComponent(path)}` : '/login';
}
export function matchLoginLink(id: string | null): string {
  return loginLink(id ? matchLink(id) : '/match');
}
