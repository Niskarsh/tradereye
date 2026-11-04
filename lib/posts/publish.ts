import { getJson, putJson } from '../setups/store';
import { liveInstagram } from '../social/connections';
import { createCarouselContainer, createImageContainer, mediaPermalink, publishContainer, waitForContainer } from '../social/instagram';
import { signedGet, store } from '../shorts/store';
import { capHashtags } from '../shorts/posts';
import { withDisclaimer } from '../shorts/disclaimer';

/**
 * Today's P&L post on Instagram: the slides as one carousel, and any of them as Stories. The API publishes at once (no
 * schedule, no private mode), so a post cannot go out twice by a double tap: what went out is remembered in
 *   posts/<date>/state.json
 * and sending again needs `again`. YouTube is not here: its API has no way to create a channel post.
 */

export const istToday = (now = Date.now()) => new Date(now + 19800_000).toISOString().slice(0, 10);
export const validName = (s: string) => /^[a-z0-9-]{1,50}$/.test(s);
export const slideKey = (date: string, name: string) => `posts/${date}/${name}.jpg`;
const stateKey = (date: string) => `posts/${date}/state.json`;

export interface PostedItem { at: number; mediaId: string; url?: string; slides: string[] }
export interface PostsState { post?: PostedItem; stories: PostedItem[] }

export async function loadState(date: string): Promise<PostsState> {
  return (await getJson<PostsState>(store, stateKey(date))) ?? { stories: [] };
}

export const finalCaption = (caption: string) => withDisclaimer(capHashtags(caption), 'instagram');

async function imageUrl(date: string, name: string): Promise<string> {
  if (!await store.get(slideKey(date, name))) throw new Error(`The image "${name}" is missing. Try again.`);
  return signedGet(slideKey(date, name), 3600, 'image/jpeg');
}

async function ready(accessToken: string, containerId: string): Promise<void> {
  const s = await waitForContainer(accessToken, containerId, 40_000, 2_000);
  if (s.code !== 'FINISHED') throw new Error(`Instagram could not process the image (${s.code}${s.detail ? `: ${s.detail}` : ''}).`);
}

async function conn() {
  const { conn: c } = await liveInstagram();
  if (!c) throw new Error('Instagram is not connected.');
  return c;
}

/** Publishes the slides (2 to 10 as a carousel, 1 as a single image). */
export async function publishPost(date: string, slides: string[], caption: string, again = false): Promise<PostsState> {
  const state = await loadState(date);
  if (state.post && !again) throw new Error('Today\'s post is already on Instagram.');
  const c = await conn();
  const text = finalCaption(caption);
  let containerId: string;
  if (slides.length === 1) {
    containerId = await createImageContainer({ accessToken: c.accessToken, userId: c.userId, imageUrl: await imageUrl(date, slides[0]), caption: text });
  } else {
    const children: string[] = [];
    for (const name of slides) children.push(await createImageContainer({ accessToken: c.accessToken, userId: c.userId, imageUrl: await imageUrl(date, name), carouselItem: true }));
    for (const id of children) await ready(c.accessToken, id);
    containerId = await createCarouselContainer({ accessToken: c.accessToken, userId: c.userId, children, caption: text });
  }
  await ready(c.accessToken, containerId);
  const mediaId = await publishContainer({ accessToken: c.accessToken, userId: c.userId, containerId });
  const url = await mediaPermalink(c.accessToken, mediaId).catch(() => '');
  const next: PostsState = { ...state, post: { at: Date.now(), mediaId, url: url || undefined, slides } };
  await putJson(store, stateKey(date), next);
  return next;
}

/** Publishes one image as a Story (live for 24 hours; a Story has no caption). */
export async function publishStory(date: string, slide: string, again = false): Promise<PostsState> {
  const state = await loadState(date);
  if (state.stories.some((s) => s.slides[0] === slide) && !again) throw new Error('That Story is already on Instagram.');
  const c = await conn();
  const containerId = await createImageContainer({ accessToken: c.accessToken, userId: c.userId, imageUrl: await imageUrl(date, slide), story: true });
  await ready(c.accessToken, containerId);
  const mediaId = await publishContainer({ accessToken: c.accessToken, userId: c.userId, containerId });
  const next: PostsState = { ...state, stories: [...state.stories, { at: Date.now(), mediaId, slides: [slide] }] };
  await putJson(store, stateKey(date), next);
  return next;
}
