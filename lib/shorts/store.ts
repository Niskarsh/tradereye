import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getChunk, putChunk } from '../book/s3';
import { getJson, putJson, type Store } from '../setups/store';
import type { ShortSpec, Template } from './spec';

/**
 * Where the shorts live in S3 (same bucket as everything else):
 *
 *   shorts/index.json              every short made, newest first (the YouTube page lists these)
 *   shorts/<id>/spec.json          what the video shows (written here, read by the GitHub job)
 *   shorts/<id>/status.json        queued -> rendering -> done / failed (the job updates it)
 *   shorts/<id>/short.mp4          the video (1080x1920)
 *   shorts/<id>/poster.jpg         a still for the list
 */

export const store: Store = {
  get: async (key) => {
    try { return await getChunk(key); }
    catch (e) { if ((e as { name?: string }).name === 'AccessDenied') return undefined; throw e; }
  },
  put: putChunk,
};

export interface ShortItem { id: string; kind: Template; label: string; createdAt: number }
export interface ShortStatus { state: 'queued' | 'rendering' | 'done' | 'failed'; updatedAt: number; error?: string }

export const INDEX_KEY = 'shorts/index.json';
export const specKey = (id: string) => `shorts/${id}/spec.json`;
export const statusKey = (id: string) => `shorts/${id}/status.json`;
export const videoKey = (id: string) => `shorts/${id}/short.mp4`;
export const posterKey = (id: string) => `shorts/${id}/poster.jpg`;
export const validId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);

/** A job that has said nothing for this long is treated as failed (GitHub never started it, or it died). */
export const STALE_MS = 20 * 60_000;

export async function listShorts(): Promise<ShortItem[]> {
  return (await getJson<ShortItem[]>(store, INDEX_KEY)) ?? [];
}

export async function addShort(spec: ShortSpec, label: string): Promise<ShortItem> {
  const item: ShortItem = { id: spec.id, kind: spec.content.kind, label, createdAt: spec.createdAt };
  await putJson(store, specKey(spec.id), spec);
  await putJson(store, statusKey(spec.id), { state: 'queued', updatedAt: Date.now() } satisfies ShortStatus);
  const all = await listShorts();
  await putJson(store, INDEX_KEY, [item, ...all.filter((x) => x.id !== item.id)].slice(0, 200));
  return item;
}

export async function setStatus(id: string, s: ShortStatus): Promise<void> { await putJson(store, statusKey(id), s); }

export async function statusOf(id: string, now = Date.now()): Promise<ShortStatus> {
  const s = await getJson<ShortStatus>(store, statusKey(id));
  if (!s) return { state: 'failed', updatedAt: now, error: 'No status saved.' };
  if ((s.state === 'queued' || s.state === 'rendering') && now - s.updatedAt > STALE_MS) {
    return { ...s, state: 'failed', error: 'The render job never finished. Check the "Render short" run on GitHub Actions.' };
  }
  return s;
}

let client: S3Client | null = null;
const s3 = () => (client ??= new S3Client({
  region: process.env.AWS_REGION!,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
}));
const bucket = () => process.env.AWS_S3_BUCKET_NAME!;

/** A private, time-limited link to the video or poster (for the preview, and for Instagram to fetch the video). */
export async function signedGet(key: string, seconds = 3600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: seconds });
}

export async function deleteShort(id: string): Promise<void> {
  const all = await listShorts();
  await putJson(store, INDEX_KEY, all.filter((x) => x.id !== id));
  for (const key of [specKey(id), statusKey(id), videoKey(id), posterKey(id)]) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })).catch(() => {});
  }
}
