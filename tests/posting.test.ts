import test from 'node:test';
import assert from 'node:assert/strict';
import { fromIstInput, istLabel, nextSlots, toIstInput } from '../lib/shorts/slots';
import { blocksDelete, igStep, LATE_MS, PREPARE_MS, takenSlots, youtubeState, type PlatformPost } from '../lib/shorts/posts';
import { canManage, deleteVideo, updateVideo, YOUTUBE_SCOPES, MANAGE_SCOPE } from '../lib/social/youtube';
import { gate } from '../lib/auth/gate';

const IST = (s: string) => fromIstInput(s);

test('IST times: input <-> moment round trip, fixed +05:30', () => {
  const at = IST('2026-10-26T18:30');
  assert.equal(new Date(at).toISOString(), '2026-10-26T13:00:00.000Z');
  assert.equal(toIstInput(at), '2026-10-26T18:30');
  assert.ok(Number.isNaN(IST('26/10/2026 18:30')));
  assert.match(istLabel(at), /Mon.*26.*Oct.*6:30/i);
});

test('default slots: next free Mon / Wed / Fri 18:30 IST, skipping taken ones and ones too close', () => {
  const sat = IST('2026-10-24T22:00');  // Saturday night
  assert.deepEqual(nextSlots(3, sat).map(toIstInput), ['2026-10-26T18:30', '2026-10-28T18:30', '2026-10-30T18:30']);
  // Monday's slot already used by another short
  assert.deepEqual(nextSlots(2, sat, [IST('2026-10-26T18:30')]).map(toIstInput), ['2026-10-28T18:30', '2026-10-30T18:30']);
  // Monday 18:20: today's slot is under 15 minutes away, so Wednesday first
  assert.equal(toIstInput(nextSlots(1, IST('2026-10-26T18:20'))[0]), '2026-10-28T18:30');
});

test('Instagram timer: prepares 20 min ahead, publishes at the time, gives up when badly late', () => {
  const at = IST('2026-10-26T18:30');
  const p: PlatformPost = { at, state: 'scheduled', updatedAt: 0 };
  assert.equal(igStep(p, at - PREPARE_MS - 60_000), 'wait');
  assert.equal(igStep(p, at - PREPARE_MS + 60_000), 'prepare');
  const ready: PlatformPost = { ...p, state: 'processing', containerId: '1', containerAt: at - 10 * 60_000 };
  assert.equal(igStep(ready, at - 60_000), 'wait');        // never before its time
  assert.equal(igStep(ready, at + 60_000), 'check');
  assert.equal(igStep({ ...ready, containerAt: at - 24 * 3_600_000 }, at), 'prepare');  // expired at Meta: made again
  assert.equal(igStep(p, at + LATE_MS + 60_000), 'missed');
  assert.equal(igStep({ ...p, state: 'live' }, at + 60_000), 'wait');
  assert.equal(igStep({ ...p, state: 'failed' }, at + 60_000), 'wait');
});

test('YouTube makes it public itself; scheduled shorts cannot be deleted; taken slots', () => {
  const at = IST('2026-10-26T18:30');
  const yt: PlatformPost = { at, state: 'scheduled', updatedAt: 0, videoId: 'v' };
  assert.equal(youtubeState(yt, at - 1), 'scheduled');
  assert.equal(youtubeState(yt, at + 1), 'live');
  assert.equal(blocksDelete({ youtube: yt }, at - 1), true);
  assert.equal(blocksDelete({ youtube: yt }, at + 1), false);
  assert.equal(blocksDelete({ instagram: { at, state: 'processing', updatedAt: 0 } }, at + 1), true);
  assert.deepEqual(takenSlots({ a: { youtube: yt, instagram: { ...yt } }, b: { youtube: { ...yt, at: at - 200 } } }, at - 100), [at, at]);
});

test('YouTube: change and unschedule need force-ssl; update keeps it private with the new time', async () => {
  assert.ok(YOUTUBE_SCOPES.includes(MANAGE_SCOPE));
  assert.equal(canManage('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'), false);
  assert.equal(canManage(YOUTUBE_SCOPES.join(' ')), true);
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(init?.method === 'DELETE' ? null : '{}', { status: init?.method === 'DELETE' ? 204 : 200 }); }) as typeof fetch;
  await updateVideo('tok', 'vid1', { title: 'A <b> title', privacy: 'private', publishAt: '2026-10-26T13:00:00.000Z' }, fake);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(calls[0].init?.method, 'PUT');
  assert.equal(body.id, 'vid1');
  assert.equal(body.snippet.title, 'A b title');
  assert.deepEqual(body.status, { privacyStatus: 'private', selfDeclaredMadeForKids: false, publishAt: '2026-10-26T13:00:00.000Z' });
  await assert.rejects(updateVideo('tok', 'vid1', { title: 't', privacy: 'public', publishAt: '2026-10-26T13:00:00.000Z' }, fake));
  await deleteVideo('tok', 'vid1', fake);
  assert.equal(calls[1].init?.method, 'DELETE');
  assert.match(calls[1].url, /id=vid1/);
  await deleteVideo('tok', 'gone', (async () => new Response('{}', { status: 404 })) as typeof fetch);  // already gone = fine
});

test('the posting timer is reachable without sign-in (it has its own secret); scheduling is not', () => {
  assert.equal(gate('/api/social/tick', false), 'allow');
  assert.equal(gate('/api/shorts/schedule', false), 'deny-api');
  assert.equal(gate('/api/shorts/post-now', false), 'deny-api');
});
