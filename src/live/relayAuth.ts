const TOKEN_KEY = 'velox-relay-token';

let cached: string | null = null;

/**
 * The relay token can be supplied once as ?token=...; it is stored locally and
 * removed from the address bar. Read access stays public.
 */
export function getRelayToken(): string {
  if (cached !== null) return cached;

  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) {
    localStorage.setItem(TOKEN_KEY, fromQuery);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    cached = fromQuery;
    return cached;
  }

  cached = localStorage.getItem(TOKEN_KEY) ?? '';
  return cached;
}

export function relayAuthHeaders(): Record<string, string> {
  const token = getRelayToken();
  return token ? { 'x-live-token': token } : {};
}
