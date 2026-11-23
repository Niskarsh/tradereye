import type { Posts } from './posts';
import type { ShortItem } from './store';

/**
 * Which trades / weeks already have a short, read from the shorts index (so deleting a short frees its trade again).
 * New shorts carry `ref` (TradeGroupId or week); older ones are matched by their label, which was always built the
 * same way ("Mystery: SYMBOL · 15 Jul 2026", "Me vs Algo · Week of 19 Oct 2026").
 */
export interface Used { n: number; scheduled: boolean; lastAt: number }

export function usedBy(items: ShortItem[], posts: Posts, kind: 'mystery' | 'vs', ref: string, label: string): Used | undefined {
  const mine = items.filter((it) => it.kind === kind && (it.ref ? it.ref === ref : it.label === label));
  if (!mine.length) return undefined;
  return {
    n: mine.length,
    scheduled: mine.some((it) => !!(posts[it.id]?.youtube || posts[it.id]?.instagram)),
    lastAt: Math.max(...mine.map((it) => it.createdAt)),
  };
}
