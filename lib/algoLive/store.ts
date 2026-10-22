import { getChunk, putChunk } from '../book/s3';
import type { Store } from '../setups/store';

/**
 * Algo Live keeps its day in the same S3 bucket as everything else, under setups/live/ (a prefix the app's AWS key can
 * already read and write). Without s3:ListBucket, S3 answers AccessDenied (not NoSuchKey) for a file that does not
 * exist yet (the day's state before the first press, for one): that is "not there", not an error.
 */
export const liveStore: Store = {
  get: async (key) => {
    try { return await getChunk(key); }
    catch (e) { if ((e as { name?: string }).name === 'AccessDenied') return undefined; throw e; }
  },
  put: putChunk,
};
