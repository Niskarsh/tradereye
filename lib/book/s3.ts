import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Order-book chunks in the same bucket as the screenshots, under order-book/. Server side only. */
let client: S3Client | null = null;
const s3 = () => (client ??= new S3Client({
  region: process.env.AWS_REGION!,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
}));
const bucket = () => process.env.AWS_S3_BUCKET_NAME!;

export async function putChunk(key: string, body: Uint8Array): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: 'application/gzip' }));
}

/** The chunk's bytes, or undefined when it does not exist (S3 says NoSuchKey, or AccessDenied without list rights). */
export async function getChunk(key: string): Promise<Uint8Array | undefined> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return r.Body ? await r.Body.transformToByteArray() : undefined;
  } catch (e) {
    const name = (e as { name?: string; Code?: string }).name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') return undefined;
    throw e;
  }
}

/** The 10-minute slots saved in one stock-day folder ("0915", "0925", ...). Needs s3:ListBucket on order-book/. */
export async function listSlots(folder: string): Promise<string[]> {
  const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${folder}/`, MaxKeys: 100 }));
  return ((r.Contents ?? []) as { Key?: string }[]).map((o) => o.Key?.match(/\/(\d{4})\.gz$/)?.[1]).filter((x): x is string => !!x).sort();
}
