import test from 'node:test';
import assert from 'node:assert/strict';
import { fromIstInput, istDay, istLabel, nextSlotPairs, nextSlots, toIstInput } from '../lib/shorts/slots';
import { blocksDelete, igStep, LATE_MS, nextWake, PREPARE_MS, RETRY_MS, takenSlots, youtubeState, type PlatformPost } from '../lib/shorts/posts';
import { atExpression, createWake, deleteWake, schedulerConfig, wakeName } from '../lib/social/scheduler';
import { signRequest } from '../lib/aws/sigv4';
import { addToPlaylist, setThumbnail, canManage, deleteVideo, removeFromPlaylist, updateVideo, YOUTUBE_SCOPES, MANAGE_SCOPE } from '../lib/social/youtube';
import { gate } from '../lib/auth/gate';

const IST = (s: string) => fromIstInput(s);

test('IST times: input <-> moment round trip, fixed +05:30', () => {
  const at = IST('2026-10-26T18:30');
  assert.equal(new Date(at).toISOString(), '2026-10-26T13:00:00.000Z');
  assert.equal(toIstInput(at), '2026-10-26T18:30');
  assert.ok(Number.isNaN(IST('26/10/2026 18:30')));
  assert.match(istLabel(at), /Mon.*26.*Oct.*6:30/i);
});

test('slots: next free Mon / Wed / Fri at a time, skipping taken ones and ones too close', () => {
  const sat = IST('2026-10-24T22:00');  // Saturday night
  const at1830 = (n: number, now: number, taken: number[] = []) => nextSlots(n, now, taken, [1, 3, 5], '18:30');
  assert.deepEqual(at1830(3, sat).map(toIstInput), ['2026-10-26T18:30', '2026-10-28T18:30', '2026-10-30T18:30']);
  // Monday's slot already used by another short
  assert.deepEqual(at1830(2, sat, [IST('2026-10-26T18:30')]).map(toIstInput), ['2026-10-28T18:30', '2026-10-30T18:30']);
  // Monday 18:20: today's slot is under 15 minutes away, so Wednesday first
  assert.equal(toIstInput(at1830(1, IST('2026-10-26T18:20'))[0]), '2026-10-28T18:30');
});

test('Instagram timer: prepares 20 min ahead, publishes at the time, gives up when badly late', () => {
  const at = IST('2026-10-26T18:30');
  const p: PlatformPost = { at, state: 'scheduled', updatedAt: 0 };
  assert.equal(igStep(p, at - PREPARE_MS - 3 * 60_000), 'wait');
  assert.equal(igStep(p, at - PREPARE_MS + 60_000), 'prepare');
  const ready: PlatformPost = { ...p, state: 'processing', containerId: '1', containerAt: at - 10 * 60_000 };
  assert.equal(igStep(ready, at - 2 * 60_000), 'wait');    // never before its time
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
  assert.deepEqual(body.status, { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, publishAt: '2026-10-26T13:00:00.000Z' });
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

test('timer wake-ups: prepare 20 min ahead, publish at the time, retry every 2 min, nothing once done', () => {
  const at = IST('2026-10-26T18:30');
  const p: PlatformPost = { at, state: 'scheduled', updatedAt: 0 };
  assert.equal(nextWake(p, at - 3_600_000), at - PREPARE_MS);
  assert.equal(nextWake(p, at - 10 * 60_000), at - 10 * 60_000);                        // scheduled late: prepare now
  assert.equal(nextWake({ ...p, attempts: 1 }, at - 10 * 60_000), at - 10 * 60_000 + RETRY_MS);
  const ready: PlatformPost = { ...p, state: 'processing', containerId: '1', containerAt: at - PREPARE_MS };
  assert.equal(nextWake(ready, at - PREPARE_MS + 5_000), at);
  assert.equal(nextWake(ready, at + 5_000), at + 5_000 + RETRY_MS);                       // still processing at Meta
  assert.equal(nextWake({ ...ready, state: 'live' }, at + 5_000), undefined);
  assert.equal(nextWake(p, at + LATE_MS + 1), undefined);
  // a wake-up a few seconds early still does its step
  assert.equal(igStep(p, at - PREPARE_MS - 5_000), 'prepare');
  assert.equal(igStep(ready, at - 5_000), 'check');
});

test('AWS signing matches the official SigV4 example', () => {
  const h = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service',
    creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, now: new Date('2015-08-30T12:36:00Z') });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('EventBridge Scheduler: one-time wake-up calling the Lambda, deleted after it runs', async () => {
  const env = { SOCIAL_TIMER_LAMBDA_ARN: 'arn:aws:lambda:ap-south-1:123456789012:function:tradereye-social-timer', SOCIAL_TIMER_ROLE_ARN: 'arn:aws:iam::123456789012:role/tradereye-scheduler', AWS_REGION: 'ap-south-1', AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' };
  assert.equal(schedulerConfig(env).region, 'ap-south-1');
  assert.throws(() => schedulerConfig({ ...env, SOCIAL_TIMER_ROLE_ARN: '' }), /not set up/);
  const at = IST('2026-10-26T18:10');
  assert.equal(atExpression(at), 'at(2026-10-26T12:40:00)');
  const name = wakeName('ig', 'mystery-20261024-abcde', at);
  assert.match(name, /^tr-ig-mystery-20261024-abcde-\d+$/);
  assert.ok(name.length <= 64);
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: init?.method === 'DELETE' ? 404 : 200 }); }) as typeof fetch;
  await createWake(name, at, { short: 'x' }, fake, env, at - 3_600_000);
  assert.equal(calls[0].url, `https://scheduler.ap-south-1.amazonaws.com/schedules/${name}`);
  assert.equal(calls[0].init?.method, 'POST');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.ScheduleExpression, 'at(2026-10-26T12:40:00)');
  assert.equal(body.ScheduleExpressionTimezone, 'UTC');
  assert.equal(body.ActionAfterCompletion, 'DELETE');
  assert.deepEqual(body.FlexibleTimeWindow, { Mode: 'OFF' });
  assert.equal(body.Target.Arn, env.SOCIAL_TIMER_LAMBDA_ARN);
  assert.equal(body.Target.RoleArn, env.SOCIAL_TIMER_ROLE_ARN);
  assert.match(String((calls[0].init?.headers as Record<string, string>).authorization), /\/ap-south-1\/scheduler\/aws4_request/);
  // a time already past is moved to a minute from now
  await createWake(name, at - 600_000, {}, fake, env, at);
  assert.equal(JSON.parse(String(calls[1].init?.body)).ScheduleExpression, atExpression(at + 60_000));
  await deleteWake(name, fake, env);   // 404 = already ran: fine
  await assert.rejects(createWake(name, at, {}, (async () => new Response('{"Message":"denied"}', { status: 403 })) as typeof fetch, env), /PassRole/);
});

test('Instagram captions keep at most 5 hashtags (Instagram allows 5); words and line breaks stay', async () => {
  const { capHashtags, hashtagCount } = await import('../lib/shorts/posts');
  const c = 'Long or short here? #trading\nReal trade, real money. Not investment advice.\n#intraday #nse #Trading #stocks #chart #daytrading #money';
  const out = capHashtags(c);
  assert.equal(hashtagCount(c), 7);
  assert.equal(hashtagCount(out), 5);
  assert.equal(out, 'Long or short here? #trading\nReal trade, real money. Not investment advice.\n#intraday #nse #stocks #chart');
  assert.equal(capHashtags('no tags here'), 'no tags here');
  assert.equal(capHashtags('price #1 setup'), 'price #1 setup');
});

test('default slots: Mon / Wed / Fri, Instagram 11:00 and YouTube 15:30 IST the same day', () => {
  const sat = IST('2026-10-24T23:30');
  const pairs = nextSlotPairs(3, sat).map((p) => [toIstInput(p.instagram), toIstInput(p.youtube)]);
  assert.deepEqual(pairs, [['2026-10-26T11:00', '2026-10-26T15:30'], ['2026-10-28T11:00', '2026-10-28T15:30'], ['2026-10-30T11:00', '2026-10-30T15:30']]);
  // Monday's YouTube slot taken by another short: Monday is skipped for both
  assert.equal(toIstInput(nextSlotPairs(1, sat, [IST('2026-10-26T15:30')])[0].instagram), '2026-10-28T11:00');
  // Monday at noon: Monday's 11:00 has passed, so Wednesday
  assert.equal(toIstInput(nextSlotPairs(1, IST('2026-10-26T12:00'))[0].youtube), '2026-10-28T15:30');
  assert.equal(istDay(IST('2026-10-26T15:30')), 'Mon 26 Oct');
});

test('YouTube playlists: add (works while private) and remove by the playlist item id', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(init?.method === 'POST' ? '{"id":"item-1"}' : null, { status: init?.method === 'POST' ? 200 : 204 }); }) as typeof fetch;
  assert.equal(await addToPlaylist('tok', 'PLmystery0001', 'vid1', fake), 'item-1');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { snippet: { playlistId: 'PLmystery0001', resourceId: { kind: 'youtube#video', videoId: 'vid1' } } });
  await removeFromPlaylist('tok', 'item-1', fake);
  assert.equal(calls[1].init?.method, 'DELETE');
  assert.match(calls[1].url, /playlistItems\?id=item-1/);
});

test('risk disclaimer: added once, above the closing hashtags, on both platforms; mystery says the prices are old', async () => {
  const { withDisclaimer, DISCLAIMER_MARK, OLD_DATA_LINE } = await import('../lib/shorts/disclaimer');
  const d = 'Long or short here?\nAnswer at the end.\nReal trade, real money. Not investment advice.\n#shorts #intraday #nse';
  const out = withDisclaimer(d, 'youtube', 'mystery');
  const lines = out.split('\n');
  assert.equal(lines[0], 'Long or short here?');
  assert.equal(lines.at(-1), '#shorts #intraday #nse');            // hashtags stay last (YouTube shows them above the title)
  assert.ok(lines.at(-3)!.includes(DISCLAIMER_MARK));
  assert.ok(out.includes(OLD_DATA_LINE));
  assert.equal(withDisclaimer(out, 'youtube', 'mystery'), out);       // never twice
  const ig = withDisclaimer('My bot sat out and still won.\n#trading #algo', 'instagram', 'vs');
  assert.ok(ig.includes(DISCLAIMER_MARK) && !ig.includes(OLD_DATA_LINE));
  assert.ok(ig.endsWith('#trading #algo'));
  assert.ok(withDisclaimer('', 'instagram').startsWith('Disclaimer:'));
});

test('cover frame: YouTube gets the JPEG as the thumbnail; Instagram gets it as the Reel cover plus the frame position', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response('{"id":"c1"}', { status: 200 }); }) as typeof fetch;
  await setThumbnail('tok', 'vid1', new Uint8Array([0xff, 0xd8, 1]), fake);
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/upload\/youtube\/v3\/thumbnails\/set\?videoId=vid1&uploadType=media$/);
  assert.equal((calls[0].init?.headers as Record<string, string>)['content-type'], 'image/jpeg');
  await assert.rejects(setThumbnail('tok', 'vid1', new Uint8Array([1]), (async () => new Response('{"error":{"message":"forbidden"}}', { status: 403 })) as typeof fetch), /Partner Program/);
  const { createReelContainer } = await import('../lib/social/instagram');
  await createReelContainer({ accessToken: 't', userId: 'u', videoUrl: 'https://v', caption: 'c', coverUrl: 'https://img', thumbOffsetMs: 12345.6 }, fake);
  const body = calls[1].init?.body as URLSearchParams;
  assert.equal(body.get('cover_url'), 'https://img');
  assert.equal(body.get('thumb_offset'), '12346');
  assert.equal(body.get('media_type'), 'REELS');
});
