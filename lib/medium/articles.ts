import { randomBytes } from 'node:crypto';
import { decryptJson, encryptJson } from '../social/store';
import type { Store } from '../setups/store';
import { cleanSettings, defaultSettings, headOf, type Article, type ArticleHead, type Settings } from './article';

/**
 * Saved articles and the Medium settings, in S3 under medium/, ENCRYPTED (AES-256-GCM, key from AUTH_SECRET, like the
 * YouTube / Instagram tokens): the bucket is publicly readable, and these hold his raw answers, unpublished drafts and
 * his secret terms (the edge). Images are not stored: they are drawn from the article's data whenever the page opens.
 *
 *   medium/articles/index.enc        every article's head (newest first)
 *   medium/articles/<id>/article.enc one article
 *   medium/settings.enc              publications he writes for + secret terms
 *
 * The app's key cannot delete objects (infra/terraform/app-user.tf), so Delete hides an article (deleted: true).
 */

export const INDEX = 'medium/articles/index.enc';
export const SETTINGS = 'medium/settings.enc';
export const articleKey = (id: string) => `medium/articles/${id}/article.enc`;
export const ID = /^m-\d{8}-[0-9a-f]{12}$/;
export const newArticleId = (now = Date.now()) => `m-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('hex')}`;

const enc = new TextEncoder(), dec = new TextDecoder();
async function getEnc<T>(s: Store, key: string, secret?: string): Promise<T | undefined> {
  const b = await s.get(key);
  return b ? decryptJson<T>(dec.decode(b), secret) : undefined;
}
const putEnc = (s: Store, key: string, value: unknown, secret?: string) => s.put(key, enc.encode(encryptJson(value, secret)));

export async function loadIndex(s: Store, secret?: string): Promise<ArticleHead[]> { return (await getEnc<ArticleHead[]>(s, INDEX, secret)) ?? []; }

export async function loadArticle(s: Store, id: string, secret?: string): Promise<Article | undefined> {
  if (!ID.test(id)) return undefined;
  return getEnc<Article>(s, articleKey(id), secret);
}

/** Saves the article and its line in the index (one writer: him, so read-modify-write is enough). */
export async function saveArticle(s: Store, a: Article, secret?: string): Promise<Article> {
  const saved = { ...a, updatedAt: Date.now() };
  await putEnc(s, articleKey(a.id), saved, secret);
  const idx = (await loadIndex(s, secret)).filter((h) => h.id !== a.id);
  await putEnc(s, INDEX, [headOf(saved), ...idx].sort((x, y) => y.createdAt - x.createdAt), secret);
  return saved;
}

export async function loadSettings(s: Store, secret?: string): Promise<Settings> {
  const x = await getEnc<Settings>(s, SETTINGS, secret);
  return x ? cleanSettings(x) : defaultSettings();
}
export async function saveSettings(s: Store, x: unknown, secret?: string): Promise<Settings> {
  const clean = cleanSettings(x);
  await putEnc(s, SETTINGS, clean, secret);
  return clean;
}
