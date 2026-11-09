import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishStoryWith, startStoryWith, type StorySteps } from '../lib/posts/storySteps';
import type { PostsState } from '../lib/posts/publish';
import { steady } from '../lib/posts/stories';

function fake(codes: string[] = ['FINISHED']) {
  let state: PostsState = { stories: [] };
  const calls = { create: 0, publish: 0 };
  const published = new Set<string>();
  let failSave = false, t = 1000;
  const d: StorySteps = {
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async (s) => { if (failSave) { failSave = false; throw new Error('S3 down'); } state = JSON.parse(JSON.stringify(s)); },
    create: async () => { calls.create++; return `c${calls.create}`; },
    status: async (id) => ({ code: published.has(id) ? 'PUBLISHED' : codes.length > 1 ? codes.shift()! : codes[0], detail: '' }),
    publish: async (id) => { calls.publish++; published.add(id); return 'm1'; },
    now: () => t,
  };
  return { d, calls, get state() { return state; }, failNextSave: () => { failSave = true; }, advance: (ms: number) => { t += ms; } };
}

test('a Story waits for Instagram, then goes out once', async () => {
  const f = fake(['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED']);
  assert.equal((await startStoryWith(f.d, 'story-a')).done, false);
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, false);
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, false);
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, true);
  assert.deepEqual([f.calls.create, f.calls.publish, f.state.stories.length, f.state.pendingStories?.length], [1, 1, 1, 0]);
});

test('every step can be repeated after a lost answer without posting twice', async () => {
  const f = fake();
  await startStoryWith(f.d, 'story-a');
  await startStoryWith(f.d, 'story-a'); // the first answer never arrived
  assert.equal(f.calls.create, 1);
  await finishStoryWith(f.d, 'story-a');
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, true); // nor did this one
  assert.equal((await startStoryWith(f.d, 'story-a')).done, true);  // pressing the button again
  assert.deepEqual([f.calls.publish, f.state.stories.length], [1, 1]);
});

test('published but the save failed: it is recorded, never published a second time', async () => {
  const f = fake();
  await startStoryWith(f.d, 'story-a');
  f.failNextSave();
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, true);
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, true);
  assert.deepEqual([f.calls.publish, f.state.stories.length], [1, 1]);
});

test('Instagram refusing the image clears it, so the next try starts fresh; an old container is not reused', async () => {
  const f = fake(['ERROR']);
  await startStoryWith(f.d, 'story-a');
  await assert.rejects(finishStoryWith(f.d, 'story-a'), /could not process/);
  assert.equal(f.state.pendingStories?.length, 0);
  await startStoryWith(f.d, 'story-a');
  assert.equal(f.calls.create, 2);
  f.advance(11 * 60_000);
  await startStoryWith(f.d, 'story-a');
  assert.equal(f.calls.create, 3);
  assert.equal(f.state.pendingStories?.length, 1);
});

test('"again" posts a Story that is already up; several Stories do not disturb each other', async () => {
  const f = fake();
  for (const s of ['story-a', 'story-b', 'story-c']) await startStoryWith(f.d, s);
  assert.equal(f.state.pendingStories?.length, 3);
  for (const s of ['story-a', 'story-b', 'story-c']) await finishStoryWith(f.d, s);
  assert.deepEqual([f.state.stories.length, f.state.pendingStories?.length], [3, 0]);
  assert.equal((await startStoryWith(f.d, 'story-a', true)).done, false);
  assert.equal((await finishStoryWith(f.d, 'story-a')).done, true);
  assert.deepEqual([f.calls.publish, f.state.stories.length], [4, 4]);
});

test('a dropped connection is tried again; a silent one is cut off; an answer is final; it never hangs for ever', async () => {
  let n = 0;
  const drops = (async () => { if (++n < 3) throw new TypeError('Failed to fetch'); return new Response('{}', { status: 502 }); }) as typeof fetch;
  assert.equal((await steady('x', '/a', {}, 1000, 1, drops)).status, 502);
  assert.equal(n, 3);
  let calls = 0;
  const silent = ((_u: string, init: RequestInit) => new Promise((_r, rej) => { calls++; init.signal!.addEventListener('abort', () => rej(new Error('aborted'))); })) as unknown as typeof fetch;
  await assert.rejects(steady('Publishing', '/a', {}, 5, 1, silent), /Publishing: the connection kept dropping/);
  assert.equal(calls, 4);
});

