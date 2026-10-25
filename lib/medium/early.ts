/**
 * Algo Lab iterations 1-4, for the Building tradereye series. The kept ledger (setups/ml/iterations.json) starts at
 * iteration 5; the first four were recorded only in docs/algo-lab.md ("Iterations") and, while their runs are still
 * in the run index, in their own results files. lib/medium/source.ts uses a run's own results when it finds them and
 * these notes otherwise. Every number here is copied from docs/algo-lab.md (R are per trade).
 *
 * Split the same way as everything else in the Medium page:
 *  - `facts`: results only, always given to Claude
 *  - `changes`: what was tried and what was learned, in plain words. Offered to him unticked like the ledger's
 *    "what changed" lines; only the ones he ticks reach Claude. No input names, thresholds or rules of the strategy
 *    that trades today are in either.
 */

export interface EarlyNote {
  iteration: number;
  /** when it ran (the notes give the month only) */
  when: string;
  facts: string;
  /** the per-trade result drawn on the iterations chart, and what it is */
  bar: { value: number; note: 'exam' | 'overall' };
  changes: string[];
}

export const EARLY_NOTES: EarlyNote[] = [
  {
    iteration: 1, when: 'Oct 2026',
    facts: 'First model, one tight bracket trade tested at every 10-minute moment: 701 trades, −0.20R a trade after charges, 1 of 9 traded months green.',
    bar: { value: -0.2, note: 'overall' },
    changes: [
      'Charges are about 0.13% of the position a round trip, so a tight stop started every trade around −0.28R before the market moved at all.',
      'Found a leak: one input was really a calendar in disguise (the model was learning the date, not the market). Removed.',
      'The model leaned on what the whole market did early in the day, so many trades went the same way on the same day.',
    ],
  },
  {
    iteration: 2, when: 'Oct 2026',
    facts: 'Wider trades, a market-neutral basket, 4 years of data, the last 6 months locked away as an exam: the wide trade −0.01R a trade after charges (+0.04R before; was −0.20R). Signal (rank correlation of predictions with outcomes) 0.04, positive in 30 of 41 blind months (pure noise gives 0.002). Basket: best signal (0.05) but 4 of 16 months green.',
    bar: { value: -0.01, note: 'overall' },
    changes: [
      'Made the trades wider so charges are a smaller share of each one.',
      'Started locking the last 6 months away as an exam: decisions only from the earlier months.',
      'The basket (buy the best, short the worst at once) had the best signal but paid charges on 6 positions at a time.',
      'Dropped "ride to the close": the weakest of the three.',
    ],
  },
  {
    iteration: 3, when: 'Oct 2026',
    facts: 'Signal nearly doubled (0.040 → 0.079, positive in 39 of 40 months) but money did not follow: +0.04R a trade before charges, −0.00R after; earlier months +0.01R (14 of 27 green), exam −0.12R (1 of 4 green): FAILED the exam.',
    bar: { value: -0.12, note: 'exam' },
    changes: [
      'Gave the model each stock\'s own recent history, and tested it with and without whole-market inputs.',
      'Averaged 3 models instead of trusting one.',
      'Lesson: a model can know something real (signal up) and still lose money after charges.',
    ],
  },
  {
    iteration: 4, when: 'Oct 2026',
    facts: 'First green after charges: +0.02R a trade (t 1.0), 19 of 35 months green, +0.06R before charges, signal 0.077. Shorts +0.03R, longs −0.03R; the first hour carried it.',
    bar: { value: 0.02, note: 'overall' },
    changes: [
      'Fixed a look-ahead bug in how trades were picked (now first come, first served, as in real life).',
      'Used only the stock\'s own facts.',
      'Tested three ways to execute: market orders won. Limit orders lost, because the orders that never filled were the winners.',
    ],
  },
];
