import { getChunk, putChunk } from '../book/s3';
import type { Store } from '../setups/store';

/** Algo Live keeps its day in the same S3 bucket as everything else, under algo-live/ */
export const liveStore: Store = { get: getChunk, put: putChunk };
