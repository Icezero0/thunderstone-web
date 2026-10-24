/** Login return paths are restricted to this application's match page. */
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
export function matchLoginLink(id: string | null): string {
  return `/play?next=${encodeURIComponent(id ? matchLink(id) : '/match')}`;
}
