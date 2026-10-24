/**
 * Which paths anyone may open without signing in (used by proxy.ts). Exact paths only: a new page or API is private
 * unless it is added here on purpose.
 */
export const PUBLIC_API = new Set([
  '/api/auth/google/login', '/api/auth/google/callback', '/api/auth/me', '/api/auth/logout',
  '/api/analytics',      // public view = this month's P&L totals only (the route trims everything else)
  '/api/live/postback',  // Dhan's webhook, protected by its own POSTBACK_SECRET
  '/api/instagram/deauthorize', '/api/instagram/data-deletion',  // Meta's callbacks, accepted only when signed with IG_APP_SECRET
]);
export const PUBLIC_PAGES = new Set(['/', '/privacy']); // /privacy: Google and Meta need a public privacy policy for the YouTube/Instagram apps

export type Gate = 'allow' | 'deny-api' | 'redirect-home';

export function gate(pathname: string, signedIn: boolean): Gate {
  const path = pathname.replace(/\/+$/, '') || '/';
  const isApi = path === '/api' || path.startsWith('/api/');
  if (isApi ? PUBLIC_API.has(path) : PUBLIC_PAGES.has(path)) return 'allow';
  if (signedIn) return 'allow';
  return isApi ? 'deny-api' : 'redirect-home';
}
