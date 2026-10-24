import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * The YouTube and Instagram connections (refresh / access tokens), kept in the S3 bucket under social/, encrypted with
 * AES-256-GCM using a key derived from AUTH_SECRET. Never in Vercel env vars, never sent to the browser, never logged.
 * Changing AUTH_SECRET makes the saved connections unreadable: connect again after that.
 */

export type Platform = 'youtube' | 'instagram';

export interface YouTubeConn {
  refreshToken: string;
  channelId: string;
  channelTitle: string;
  handle: string;          // e.g. "@candlesbeforecubicles"
  scope: string;
  connectedAt: number;
}

export interface InstagramConn {
  accessToken: string;     // long-lived, ~60 days, refreshed by tradereye
  expiresAt: number;       // ms
  refreshedAt: number;     // ms
  userId: string;          // the professional account's Instagram user id (used to publish)
  username: string;
  connectedAt: number;
}

export type ConnOf<P extends Platform> = P extends 'youtube' ? YouTubeConn : InstagramConn;

function keyFrom(secret: string): Buffer {
  const s = secret.trim();
  if (s.length < 32) throw new Error('AUTH_SECRET is not set (or shorter than 32 characters).');
  return createHash('sha256').update(`tradereye-social-v1|${s}`).digest();
}

/** "iv.ciphertext+tag", both base64url. Tampering or a different AUTH_SECRET makes decrypt throw. */
export function encryptJson(value: unknown, secret = process.env.AUTH_SECRET ?? ''): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
  return `${iv.toString('base64url')}.${body.toString('base64url')}`;
}

export function decryptJson<T>(text: string, secret = process.env.AUTH_SECRET ?? ''): T {
  const [ivPart, bodyPart] = text.trim().split('.');
  if (!ivPart || !bodyPart) throw new Error('Saved connection is malformed.');
  const iv = Buffer.from(ivPart, 'base64url'), body = Buffer.from(bodyPart, 'base64url');
  if (iv.length !== 12 || body.length < 17) throw new Error('Saved connection is malformed.');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

let client: S3Client | null = null;
const s3 = () => (client ??= new S3Client({
  region: process.env.AWS_REGION!,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
}));
const bucket = () => process.env.AWS_S3_BUCKET_NAME!;
const keyOf = (p: Platform) => `social/${p}.enc`;

export async function saveConn<P extends Platform>(p: P, conn: ConnOf<P>): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: keyOf(p), Body: encryptJson(conn), ContentType: 'text/plain' }));
}

/** The saved connection, or undefined when there is none (or it can no longer be decrypted). */
export async function loadConn<P extends Platform>(p: P): Promise<ConnOf<P> | undefined> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: keyOf(p) }));
    const text = r.Body ? await r.Body.transformToString() : '';
    return text ? decryptJson<ConnOf<P>>(text) : undefined;
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') return undefined;
    if (e instanceof Error && /malformed|auth|decrypt|Unsupported state/i.test(e.message)) {
      console.warn(`[social] saved ${p} connection could not be read; connect again`);
      return undefined;
    }
    throw e;
  }
}

export async function deleteConn(p: Platform): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: keyOf(p) }));
}
