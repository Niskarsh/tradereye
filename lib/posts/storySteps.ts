import type { PostsState } from './publish';

export interface StorySteps {
  load(): Promise<PostsState>;
  save(s: PostsState): Promise<void>;
  /** gives Instagram the image; returns its container */
  create(slide: string): Promise<string>;
  status(containerId: string): Promise<{ code: string; detail: string }>;
  publish(containerId: string): Promise<string>;
  now(): number;
}
export interface StoryStep { done: boolean; state: PostsState }

const CONTAINER_LIFE_MS = 10 * 60_000;
const posted = (s: PostsState, slide: string) => s.stories.some((x) => x.slides[0] === slide);
const withoutPending = (s: PostsState, slide: string) => (s.pendingStories ?? []).filter((p) => p.slide !== slide);

/**
 * A Story goes out in short steps, so no request stays open while Instagram works (a phone can lose a long request,
 * and the page then cannot tell whether it went out). Everything is remembered in state.json, so any step can be
 * repeated after a dropped connection without posting twice.
 *
 * Step 1: hand Instagram the image. A repeat reuses the container already made.
 */
export async function startStoryWith(d: StorySteps, slide: string, again = false): Promise<StoryStep> {
  const state = await d.load();
  if (posted(state, slide) && !again) return { done: true, state };
  const open = (state.pendingStories ?? []).find((p) => p.slide === slide && d.now() - p.at < CONTAINER_LIFE_MS);
  if (open) return { done: false, state };
  const containerId = await d.create(slide);
  const next: PostsState = { ...state, pendingStories: [...withoutPending(state, slide), { slide, containerId, at: d.now() }] };
  await d.save(next);
  return { done: false, state: next };
}

/** Step 2, repeated until done: looks once at Instagram's progress and publishes when the image is ready. */
export async function finishStoryWith(d: StorySteps, slide: string): Promise<StoryStep> {
  const state = await d.load();
  const pending = state.pendingStories?.find((p) => p.slide === slide);
  if (!pending) {
    if (posted(state, slide)) return { done: true, state };
    throw new Error('That Story was not started. Press Post Story again.');
  }
  const record = async (mediaId: string): Promise<StoryStep> => {
    const next: PostsState = { ...state, pendingStories: withoutPending(state, slide), stories: [...state.stories, { at: d.now(), mediaId, slides: [slide] }] };
    await d.save(next);
    return { done: true, state: next };
  };
  const s = await d.status(pending.containerId);
  if (s.code === 'PUBLISHED') return record(''); // it went out, but the answer or the save was lost
  if (s.code === 'FINISHED') {
    try { return await record(await d.publish(pending.containerId)); }
    catch (e) {
      if ((await d.status(pending.containerId).catch(() => ({ code: '', detail: '' }))).code === 'PUBLISHED') return record('');
      throw e;
    }
  }
  if (s.code === 'IN_PROGRESS' || s.code === '') return { done: false, state };
  await d.save({ ...state, pendingStories: withoutPending(state, slide) });
  throw new Error(`Instagram could not process the image (${s.code}${s.detail ? `: ${s.detail}` : ''}).`);
}
