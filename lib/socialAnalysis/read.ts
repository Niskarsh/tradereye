import { jsonClaude, type ClaudeOptions } from '../copilot/claude';
import { getJson, putJson } from '../setups/store';
import { store } from '../shorts/store';
import { claudeOptions } from '../shorts/write';
import { matureCount, type Row } from './analyze';
import { READ_SCHEMA, readMessage, SYSTEM, toRead, type SavedRead } from './prompt';

/**
 * The on-demand read: one Claude call, only when he presses the button, that says what to change next.
 * Run like Algo Lab: one change at a time, judged on posts that had time to grow, every read kept (social/analysis/reads.json).
 */

export const READS_KEY = 'social/analysis/reads.json';

export const loadReads = async (): Promise<SavedRead[]> => (await getJson<SavedRead[]>(store, READS_KEY)) ?? [];

export async function makeRead(rows: Row[], o: ClaudeOptions = claudeOptions(), now = Date.now()): Promise<SavedRead> {
  const m = matureCount(rows);
  if (!m.youtube && !m.instagram) throw new Error('Nothing is 7 days old yet, so there is nothing fair to read.');
  const reads = await loadReads();
  const r = await jsonClaude(SYSTEM, readMessage(rows, reads[0]), READ_SCHEMA, { ...o, timeoutMs: 50_000 }, 4000);
  const read = toRead(r.json);
  if (!read.call) throw new Error(r.cutOff ? 'Claude\'s answer was cut short. Try again.' : 'Claude returned no usable answer.');
  const saved: SavedRead = { ...read, at: now, model: r.model, costInr: r.costInr, mature: m };
  await putJson(store, READS_KEY, [saved, ...reads]);
  return saved;
}
