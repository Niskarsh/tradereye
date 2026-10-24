import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createSession, isOwnerAccount, readSession, sign, unsign, b64url, cookieFrom, SESSION_COOKIE } from '../lib/auth/session';
import { ownerSessionSync } from '../lib/auth/ownerSync';
import { safeNext, verifyIdToken, pkceChallenge } from '../lib/auth/google';
import { gate } from '../lib/auth/gate';

const SECRET = 'x'.repeat(48);
const ENV = { AUTH_SECRET: SECRET, OWNER_EMAIL: 'niskarshk@gmail.com', OWNER_GOOGLE_ID: '1234567890' };
const owner = { email: 'niskarshk@gmail.com', sub: '1234567890', name: 'Nik' };
const req = (cookie?: string) => new Request('https://app.test/api/x', { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });

test('owner session: valid, then rejected when expired, edited, re-signed with another key, or owner changed', async () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const tok = await createSession(owner, now, SECRET);
  assert.ok(await readSession(tok, now, SECRET, ENV));
  assert.equal(await readSession(tok, now + 31 * 86400_000, SECRET, ENV), undefined, 'expired after 30 days');

  // someone edits the payload (e.g. to stretch the expiry): the signature no longer matches
  const [body, sig] = tok.split('.');
  const edited = JSON.parse(Buffer.from(body, 'base64url').toString()); edited.exp += 999999;
  assert.equal(await readSession(`${b64url(Buffer.from(JSON.stringify(edited)))}.${sig}`, now, SECRET, ENV), undefined);
  // a token signed with a different secret
  assert.equal(await readSession(await createSession(owner, now, 'y'.repeat(48)), now, SECRET, ENV), undefined);
  // knowing the email is not enough: a different Google account id with the same email is refused
  assert.equal(await readSession(await createSession({ ...owner, sub: '999' }, now, SECRET), now, SECRET, ENV), undefined);
  // owner changed in Vercel: old sessions stop working
  assert.equal(await readSession(tok, now, SECRET, { ...ENV, OWNER_EMAIL: 'someone@else.com' }), undefined);
  // no secret configured: nothing is accepted (fails closed)
  assert.equal(await readSession(tok, now, '', ENV), undefined);
  assert.equal(await unsign('garbage', SECRET), undefined);
  assert.equal(await unsign('a.b.c', SECRET), undefined);
});

test('the synchronous check inside guard() agrees with the proxy check', async () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const tok = await createSession(owner, now, SECRET);
  assert.equal(ownerSessionSync(req(tok), now, ENV)?.email, 'niskarshk@gmail.com');
  assert.equal(ownerSessionSync(req(), now, ENV), undefined, 'no cookie');
  assert.equal(ownerSessionSync(req(tok.slice(0, -2) + 'AA'), now, ENV), undefined, 'bad signature');
  assert.equal(ownerSessionSync(req(tok), now + 40 * 86400_000, ENV), undefined, 'expired');
  assert.equal(ownerSessionSync(req(tok), now, { ...ENV, AUTH_SECRET: '' }), undefined, 'no secret');
  assert.equal(ownerSessionSync(req(await sign({ email: 'niskarshk@gmail.com', sub: '1234567890', exp: 9e9 }, 'z'.repeat(40))), now, ENV), undefined, 'forged elsewhere');
});

test('owner match: email is case-insensitive; the Google id is required once set', () => {
  assert.ok(isOwnerAccount('NiskarshK@Gmail.com', '1234567890', ENV));
  assert.ok(!isOwnerAccount('niskarshk@gmail.com', '1', ENV));
  assert.ok(isOwnerAccount('niskarshk@gmail.com', 'anything', { OWNER_EMAIL: 'niskarshk@gmail.com' }), 'before OWNER_GOOGLE_ID is added');
  assert.ok(!isOwnerAccount('niskarshk@gmail.com', '1', {}), 'no owner configured = nobody');
  assert.equal(cookieFrom('a=1; te_session=abc.def; b=2', 'te_session'), 'abc.def');
});

test('after login, only same-site paths are followed (no open redirect)', () => {
  assert.equal(safeNext('/journal?x=1'), '/journal?x=1');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '', undefined]) assert.equal(safeNext(bad as string), '/');
});

test('gate: Home and the login routes are public; every other page and API needs the session', () => {
  assert.equal(gate('/', false), 'allow');
  assert.equal(gate('/privacy', false), 'allow');
  assert.equal(gate('/privacy/x', false), 'redirect-home');
  assert.equal(gate('/api/analytics', false), 'allow');
  assert.equal(gate('/api/auth/google/callback', false), 'allow');
  for (const p of ['/journal', '/copilot', '/order-book/', '/dhan-login']) assert.equal(gate(p, false), 'redirect-home', p);
  for (const p of ['/api/copilot/chat', '/api/journal/review', '/api/book/ask', '/api/auth/totp', '/api/upload', '/api/sheets/comment', '/api/new-route-nobody-listed'])
    assert.equal(gate(p, false), 'deny-api', p);
  assert.equal(gate('/api/copilot/chat', true), 'allow');
});

test('Google ID token: accepted only with Google\'s signature, our client id, the right nonce, unexpired, verified email', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const fetchJwks = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
  const now = Date.parse('2026-10-19T12:00:00Z');
  const base = { iss: 'https://accounts.google.com', aud: 'client-1', sub: '1234567890', email: 'niskarshk@gmail.com', email_verified: true, nonce: 'n1', iat: now / 1000, exp: now / 1000 + 3600 };
  const make = (claims: object, key = privateKey, kid = 'k1') => {
    const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))), p = b64url(Buffer.from(JSON.stringify(claims)));
    const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
    return `${h}.${p}.${b64url(s)}`;
  };
  const ok = await verifyIdToken(make(base), { clientId: 'client-1', nonce: 'n1', now }, fetchJwks);
  assert.equal(ok.email, 'niskarshk@gmail.com');
  const bad: [string, string][] = [
    [make(base, other), 'signature'],
    [make({ ...base, aud: 'someone-elses-app' }), 'different app'],
    [make({ ...base, iss: 'https://evil.example' }), 'not from Google'],
    [make({ ...base, nonce: 'n2' }), 'does not belong'],
    [make({ ...base, exp: now / 1000 - 3600 }), 'expired'],
    [make({ ...base, email_verified: false }), 'not verified'],
    [make(base, privateKey, 'unknown'), 'unknown key'],
  ];
  for (const [tok, why] of bad) await assert.rejects(verifyIdToken(tok, { clientId: 'client-1', nonce: 'n1', now }, fetchJwks), new RegExp(why), why);
  // an unsigned token ("alg: none") is refused outright
  const none = `${b64url(Buffer.from(JSON.stringify({ alg: 'none' })))}.${b64url(Buffer.from(JSON.stringify(base)))}.`;
  await assert.rejects(verifyIdToken(none, { clientId: 'client-1', nonce: 'n1', now }, fetchJwks), /algorithm/);
});

test('PKCE challenge is the S256 of the verifier (RFC 7636 example)', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
