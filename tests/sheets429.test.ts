import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsClient, SheetsApiError } from '../lib/sheetsApi';

const client = (responses: Response[], sleeps: number[]) => new SheetsClient({
  spreadsheetId: 'S', getToken: async () => 't', sleep: async (ms) => { sleeps.push(ms); },
  fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch,
});
const rate = (retryAfter?: string) => new Response('{"error":"quota"}', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

test('429: waits (honouring Retry-After), retries, and succeeds', async () => {
  const sleeps: number[] = [];
  const c = client([rate('3'), new Response(JSON.stringify({ values: [['a']] }), { status: 200 })], sleeps);
  assert.deepEqual(await c.getValues("'x'!A:A"), [['a']]);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 2250 && sleeps[0] <= 3750, `waited ${sleeps[0]}ms for Retry-After: 3`);
});

test('429 that keeps coming: gives up after a few tries with a typed error the page can back off on', async () => {
  const sleeps: number[] = [];
  const c = client([rate('20'), rate('20'), rate('20'), rate('20'), rate('20')], sleeps);
  await assert.rejects(() => c.getValues("'x'!A:A"), (e: unknown) => e instanceof SheetsApiError && e.status === 429 && e.retryAfterSec === 20);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps.every((ms) => ms <= 12_500), 'no single wait may eat the serverless time budget');
});
