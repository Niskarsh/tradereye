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
    facts: 'The very first version: one simple quick trade, tested at every 10-minute moment of the day on past data. 701 test trades; −0.20R a trade after charges (on average each trade lost 20% of what it risked); made money in 1 of the 9 months it traded.',
    bar: { value: -0.2, note: 'overall' },
    changes: [
      'Charges (about 0.13% of the money in each trade) were so big next to such a quick, small trade that every trade started around −0.28R before the price even moved.',
      'Found a leak: one input was really a calendar in disguise (the model was learning the date, not the market). Removed.',
      'It leaned on what the whole market did early in the day, so on many days all its trades went the same way: one bad morning hit everything at once.',
    ],
  },
  {
    iteration: 2, when: 'Oct 2026',
    facts: 'Wider trades, a new "basket" idea, 4 years of past data, and the last 6 months locked away as an exam. The wider trade: −0.01R a trade after charges, +0.04R before charges (close to breaking even, up from −0.20R). The model\'s predictions did line up with what happened, a little: signal 0.04, positive in 30 of 41 months it had never seen (pure chance gives about 0.002). The basket had the best signal (0.05) but made money in only 4 of 16 months.',
    bar: { value: -0.01, note: 'overall' },
    changes: [
      'Made the trades wider so charges are a smaller share of each one.',
      'Started locking the last 6 months away as an exam: decisions only from the earlier months.',
      'The basket (buy the best, short the worst at once) had the best signal but paid charges on 6 positions at a time.',
      'Dropped "ride to the close" (holding until the end of the day): the weakest of the three ideas.',
    ],
  },
  {
    iteration: 3, when: 'Oct 2026',
    facts: 'The model got much better at predicting (signal nearly doubled, 0.040 to 0.079, positive in 39 of 40 months) but the money did not follow: +0.04R a trade before charges, about zero after. Decide months +0.01R a trade (money made in 14 of 27 months); exam −0.12R a trade (money made in 1 of 4 months): FAILED the exam.',
    bar: { value: -0.12, note: 'exam' },
    changes: [
      'Gave the model each stock\'s own recent history, and tested it with and without whole-market inputs.',
      'Averaged 3 models instead of trusting one.',
      'Lesson: a model can know something real (signal up) and still lose money after charges.',
    ],
  },
  {
    iteration: 4, when: 'Oct 2026',
    facts: 'First time it made money after charges: +0.02R a trade (each trade made 2% of what it risked, on average), confidence score t 1.0 (could still be luck), money made in 19 of 35 months, +0.06R before charges, signal 0.077. Short trades (bets on a fall) +0.03R, long trades (bets on a rise) −0.03R; most of it came from the first hour of the day.',
    bar: { value: 0.02, note: 'overall' },
    changes: [
      'Fixed a bug where the test could pick trades using information it would not have had yet at that moment (called look-ahead): too good to be true. Now it takes trades first come, first served, like in real life.',
      'Let the model look only at each stock itself, not the wider market.',
      'Tried three ways to place orders. Taking whatever the current price is (a market order) won. Waiting for a set price (a limit order) lost: the orders that never got filled were exactly the trades that would have won.',
    ],
  },
];
