import { getChunk, putChunk } from '../book/s3';
import type { Store } from '../setups/store';

/** The trend radar's S3 files (medium/...), same bucket as everything else. The AWS key needs Get/Put on medium/*. */
export const mediumStore: Store = {
  get: async (key) => {
    try { return await getChunk(key); }
    catch (e) { if ((e as { name?: string }).name === 'AccessDenied') return undefined; throw e; }
  },
  put: putChunk,
};
