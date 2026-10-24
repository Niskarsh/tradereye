# Sign-in (Google, owner only)

Home is public and shows only this month's P&L totals. Everything else (pages and APIs, including every route that
calls Claude, writes the sheet, uploads to S3 or talks to Dhan) needs the owner's Google session.

## How it works
1. **Sign in with Google** goes to Google's own sign-in page (`/api/auth/google/login`), with a random state, nonce and
   PKCE challenge kept in a signed 10-minute cookie.
2. Google returns a one-time code to `/api/auth/google/callback`. The server swaps it for an ID token directly with
   Google using `GOOGLE_CLIENT_SECRET` (never sent to the browser).
3. The ID token must pass every check: Google's RS256 signature (Google's published keys), issuer, audience = our client
   id, not expired, our nonce, email verified. Then the account must be the owner: `OWNER_EMAIL` and, once set,
   `OWNER_GOOGLE_ID` (Google's fixed account number, so knowing the email is not enough).
4. The server sets `te_session`: a cookie signed with `AUTH_SECRET` (HMAC-SHA256), httpOnly, Secure, SameSite=Lax,
   30 days. Nobody can make or edit one without the secret. Changing `OWNER_EMAIL` / `OWNER_GOOGLE_ID` / `AUTH_SECRET`
   in Vercel signs every old session out.

## Two locks
- `proxy.ts` (Next 16's request gate) runs before every page and API. Public: `/`, `/privacy` (the privacy policy Google and Meta link to), the four `/api/auth/google|me|logout`
  routes, `/api/analytics` (trimmed to P&L totals when signed out) and `/api/live/postback` (its own secret).
  Everything else: pages redirect to Home with a sign-in prompt, APIs answer 401. New routes are private by default.
- Every private route checks the session again itself (`guard()` in `lib/live/guard.ts`, `ownerRequired` elsewhere),
  so a mistake in the proxy's list still could not open the AI, the sheet or S3.

Log out removes the session cookie and the Dhan token stored in that browser.

## Setup
Google Cloud Console: OAuth consent screen (External, Testing, test user = your Gmail, scopes openid / email / profile),
then a Web application client with redirect URIs `https://<domain>/api/auth/google/callback` and
`http://localhost:3000/api/auth/google/callback`. Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET`
(`openssl rand -base64 48`), `OWNER_EMAIL`, then after the first sign-in `OWNER_GOOGLE_ID`. Redeploy after changes.
