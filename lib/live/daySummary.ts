import type { SyncResult } from './sync';

/** What one "Fetch & save" press did, in words for the Fetch Today's Trades page. */
export interface DaySummary {
  closed: number;
  /** written to the monthly sheet by this press */ savedNow: number;
  /** in the sheet already (an earlier press, Live, or by hand) */ alreadyIn: number;
  /** completed but not in the sheet yet (a sheet error: see the warnings; pressing again retries) */ notSaved: number;
  open: number;
  line: string;
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function summarizeDay(r: Pick<SyncResult, 'groups' | 'finalized'>): DaySummary {
  const closed = r.groups.filter((g) => g.status === 'CLOSED');
  const loggedNow = new Set(r.finalized.filter((f) => f.result === 'LOGGED').map((f) => f.id));
  const savedNow = closed.filter((g) => loggedNow.has(g.id)).length;
  const alreadyIn = closed.filter((g) => !loggedNow.has(g.id) && (g.saved === 'LOGGED' || g.saved === 'DUPLICATE')).length;
  const notSaved = closed.length - savedNow - alreadyIn;
  const open = r.groups.filter((g) => g.status === 'OPEN').length;

  const parts: string[] = [];
  if (!r.groups.length) parts.push('No trades today');
  else {
    parts.push(`${n(closed.length, 'completed trade')}`);
    if (savedNow) parts.push(`${savedNow} saved to the sheet now`);
    if (alreadyIn) parts.push(`${alreadyIn} already in the sheet`);
    if (notSaved) parts.push(`${notSaved} not saved yet (press again)`);
    if (open) parts.push(`${n(open, 'open position')} (saved once flat)`);
  }
  return { closed: closed.length, savedNow, alreadyIn, notSaved, open, line: parts.join(' · ') };
}
