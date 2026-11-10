# Algo Lab

**My Analysis → Algo Lab.** Machine learning the way algo desks test it, on every stock in his price range. Each
backtest run is one **iteration**; the page keeps a table of every iteration so far.

1. **Dataset** (lib/ml/grid.ts, written during the backtest job to `ml-data/`, never uploaded): every 10-min close
   09:35–14:45 of every stock-day in the universe (NSE, ₹250–340, 5 lakh+ shares average volume) over the last
   **4 years** (`ML_YEARS`; the setups and the Reversal Study keep 2): 47 facts known at that moment (moves, VWAP, day
   range, tests of the high/low, candle shape, volume, Nifty 500, relative strength, EMAs, previous-day and value-area
   levels, volatility, price; from iteration 3 also memory: each stock's habit from that time of day over its last 20
   sessions and the multi-day picture) and the results of trades taken there, long and short, after and before Dhan's charges
   at ₹300 risk (entry 1 tick worse than the close, stops 1 tick worse, targets only when traded through, same minute
   = stop):
   - tight bracket: stop 1 ATR (10-min), target 1.5 ATR, out by 15:00 (iteration 1; kept as a reference);
   - wide bracket: stop ½ the usual daily range, target ¾ of it, out by 15:15;
   - ride to the close: safety stop ¾ of the usual daily range, no target, out at 15:15;
   - the plain move to 15:15 (%), for the market-neutral ranking.
2. **Walk-forward models** (scripts/ml_walkforward.py, scikit-learn gradient-boosted trees), with cross-sectional ranks
   (this stock vs all others at the same minute). For each month: train on up to 18 months before the 2 validation
   months, pick the bar to trade on those 2 months (a top slice of the predictions; stand aside if nothing was
   profitable), trade the month blind. Strategies:
   - **wide bracket** and **ride to the close**: one model per side; one trade per stock a day, 4 a side and 6 a day
     at most;
   - **market-neutral basket**: one model ranks stocks by their move to 15:15 relative to all the others at that
     minute; at 09:45, 10:45 and 11:45 it buys the 3 best and shorts the 3 worst (each stock once a day).
3. **Results** (`setups/runs/<runId>/ml.json.gz`, v2, scripts/ml-upload.ts): per strategy, out-of-sample trades, R
   after and before costs, t, months green, the **earlier months** vs the **exam** (the last 6 months: next steps are
   decided from the earlier months only), signal (rank correlation of predictions with outcomes, month by month), ₹
   per month, worst drop, by side and hour, what the model leans on, what its trades look like, its latest trades.

Proven before use (tests/py/test_ml_walkforward.py): on pure noise no strategy reports an edge and the signal is ~0;
a planted directional edge is found by the wide bracket and a planted cross-sectional edge (under a big shared market
move) by the basket, out of sample, month after month, leaning on the planted facts. tests/ml.test.ts: every label
matches an independent replay of its trade, no look-ahead in the facts, and the file Python reads is exactly what was
written.

## Iterations

1. **Tight bracket, every moment** (Oct 2026): 701 trades, −0.20R after costs, 1 of 9 traded months green. Charges
   are ~0.13% of the position a round trip, so a 1-ATR 10-min stop (~0.46% of price) starts every trade ~−0.28R; the
   model leaned on the Nifty's first 5 minutes (market-timing, many same-direction trades on one day) and on the
   number of stocks in the universe (a calendar in disguise, removed).
2. **Wider trades, a market-neutral basket, 4 years, locked exam months** (Oct 2026): costs fixed (wide bracket
   −0.01R after costs, +0.04R before; was −0.20R). Signal real but small: rank correlation 0.04, positive in 30 of 41
   blind months (noise: 0.002). Still 41% leaning on Nifty's first 5 minutes. Ride to the close weakest (dropped);
   basket best signal (0.05) but 6 legs of charges, 4 of 16 months green.
3. **Memory facts, with vs without Nifty, 3-model average, 3 validation months** (Oct 2026): without Nifty facts the
   signal nearly doubled (0.040 → 0.079, positive 39 of 40 months) and memory facts lead; but still +0.04R before
   costs, −0.00R after; earlier months +0.01R (14/27 green), exam −0.12R (1/4).
4. **Stock facts only, first-come-first-served picks (a look-ahead fix), min 1,500 moments per rule, three executions
   (market / limit at the close / limit with ~₹3 lakh positions)** (Oct 2026): first green after costs, +0.02R (t 1.0),
   19/35 months; +0.06R before costs; signal 0.077. Shorts +0.03R, longs −0.03R; the first hour carries it. Limit
   orders were worse (the unfilled ones were the winners).
5. **Four variants (control / shorts only / 09:35–10:55 only / basket), 30 training months, position sizes ₹300 risk /
   ~₹1 lakh / ~₹3 lakh with market orders, breakdowns on earlier months only** (Oct 2026): shorts only best, +0.03R
   (t 1.9), exam +0.05R (4/6 green); ₹1 lakh positions +0.04R (t 2.5). Kept as branch `algo-iter-5`.
6. **Shorts benchmark (B) vs shorts also at 09:25 (E, 2-tick entry there) vs control (A); every iteration preserved**
   (Oct 2026): B +0.05R (t 2.6), earlier +0.04R and exam +0.06R; E no better. Tag algo-iter-6-2026-10-22-01-21-gsti.
7. **B vs nearer (½) / farther (1×) targets, 5-model average, "your day" view** (Oct 2026): F (½) best on the decide
   months, +0.05R (t 3.4), 23/31 decide months green. Locked.
8. **Clean data split + trade management** (this version):
   - the dataset starts 1 Jan 2022 (`ML_FROM`); Jan–Sep 2022 is the untouched test (`DECIDE_FROM` in
     scripts/ml_walkforward.py): never in any walk-forward; the locked F is tested on it once, its models trained on the
     30 decide months after it and the bar set on the 3 after those;
   - every diagnostic is from the decide months; the exam is Pass / Fail on the page;
   - noise check: F trained five times (main + seed2..seed5, parallel GitHub jobs);
   - trade management (lib/ml/manage.ts, run in the finish job by lib/ml/manageRun.ts on the 1-minute candles in S3):
     the same trades of B, F and G replayed with break-even stops (40/60/80% of the way to the target) and adding once
     or twice (momentum or pullback; at 40/60%; same or half size; one stop for the whole position placed where it
     loses 1R / 0.5R / 0 of the first trade's risk, never loosened; target kept or moved to 1× / 1.5× the daily range;
     only if the add can win 1× / 1.5× its own room and before 14:15; a second add halfway to the target or 0.5R past
     the first). Stage 1 picks the best of each family on the first half of the decide months; stage 2 judges those and
     the best break-even combined with each add on the second half; a winner must beat "as now" with t ≥ 2 and gets one
     shot at the untouched months in the next iteration. Each add pays its own charges (about 0.1R at ₹300 risk).
   Result: untouched F +0.15R (t 3.0, 9/9 green); noise +0.06 to +0.08R; break-even never helps; one add rule held for
   B only (+0.06R on the second half, t 2.9).
9. **Confirm, no search** (this version): F and B unchanged (G dropped); the untouched months for B and for B with the
   add rule fixed in iteration 8 (`CONFIRM` in lib/ml/manageRun.ts, replayed on decide / exam / untouched / shadow
   trades); shadow months from Nov 2026 (`SHADOW_FROM`), never used for any decision; a money card (₹ a month,
   position, margin at 5×, capital incl. the deepest run of losses, % a month). After this the strategy is frozen as
   v1; further research goes on separate strategies or new data.
   Result: F untouched +0.17R (t 3.4, 9/9), decide +0.06R (draws +0.05 to +0.07R); B decide +0.04R, untouched +0.20R;
   the add rule did not confirm on the untouched months (+0.04R, t 0.8). Worst day −4.25R (4 shorts at most).
10. **How many trades a day** (this version): F unchanged and locked; B and the add rule dropped. Four versions of F
   share F's models and differ only in which trades they take, all but the first with no new entry after 10:55: up to
   4 a day as now, first come first served 3 a day, 2 a day, and strict (`perDay` in scripts/ml_walkforward.py: the
   bar is set each month on the 3 months before among higher quantiles, only bars that let through about 2 trades a
   day or fewer there; at most 3 taken). Rule fixed before the run (`CAP_ORDER`, `CAP_RULE`): the smallest daily risk
   that keeps +0.05R a trade with t ≥ 2.5 on the decide months. Placebo: F's pipeline trained on outcomes shuffled
   among the stocks of the same month and minute, traded on the real outcomes; it must show no edge. Every version
   gets the 5 training draws (`noiseAll`) and the untouched months (a second look for F, not a clean test).
11. **Real fills by liquidity, the next step on F (not a restart)** (this version): F as Algo Live trades it (short,
   09:35–10:55, first 2 a day) keeps its models, facts and bar recipe; nothing is re-tuned. The dataset gains two
   columns no model reads (`avgVol`, the 10-day average volume; `nbSx`, F's short filled by liquidity, `LIQ_BANDS` in
   lib/ml/grid.ts): 5 lakh–3M shares 3 ticks worse in and out with the target needing a 3-tick trade-through and stops
   slipping 0.20% of price; 3–5M 2 ticks / 0.10%; 5–7M 1 tick / 0.06%; 7–10M 1 tick / 0.05%; 10M+ 1 tick / 0.04%; a stop
   hit in a fast 10-min candle slips at least 10% of its range. Versions: F as live with the old fills, and with real
   fills at floors 5 lakh (all), 3M, 5M, 7M, 10M (`VOL_ORDER`); F's trades split by band, real vs old fills. Rule fixed
   before the run (`VOL_RULE`): the highest floor with +0.04R a trade, t ≥ 2.0 and 150+ trades on the decide months.
   Placebo, the 5 training draws and the untouched months (a second look) as in iteration 10. To be calibrated later
   with Algo Live's own fills.
12. **More stocks to choose from, research only** (`scripts/ml_wide.py`, its own workflow `Algo Lab wide universe`, Run button on
   Algo Lab): F as Algo Live trades it, on ₹250–1000 against ₹250–340. ₹300 of risk buys about the same rupee position at any
   share price, so the band is not a capital limit. Same facts and bar recipe; only the stocks differ.
   - **Fills:** the same liquidity floor in rupees (about ₹17 crore a day). Above ₹340 a stock's volume is scaled to a ₹340 stock
     and tick-based slippage grows with price, so a dearer stock is not helped by a tick being a smaller share of its price
     (`wideVol`, `gridDay(..., wide)`). At ₹340 or less the rows equal the normal dataset's (`tests/mlWide.test.ts`).
   - **Like for like:** the dataset holds 09:25–10:55 only (the full day on this many stocks does not fit a GitHub machine), and
     the ₹250–340 control learns from those same moments, so its number is not comparable with earlier iterations.
   - **Rule fixed before the run** (`wideVerdict`, decide months, real fills): the highest floor with +0.04R a trade, t ≥ 2.0 and
     150+ trades; its average over the 5 training draws beats the control's best draw; more R in total; the placebo shows no edge.
   - **Kept apart from Algo Live:** `ml_walkforward.py` is not edited (`ml_wide.py` sets this iteration's values in its own
     process); the dataset is the artifact `grid-wide`, not `grid`; the results go only to the ledger, not the run index; no
     strategy is called `fCap2`. The job stops itself 08:40–11:15 on weekdays unless "Run during market hours" is ticked (then it
     keeps going at 1 Dhan request a second in that window, leaving Algo Live the other 4, and backs off on Dhan's rate-limit
     reply). NSE holidays (`NSE_HOLIDAYS`, add each year's list in December) run at full speed with no override; with the override on, a
     holiday missing from the list is caught from 09:20 by one Nifty 500 request (no candles today). It will not start during a backtest, because all of them share Dhan's request limit. Stopped or timed out, it carries on from the saved candles when pressed again.
13. **Does iteration 12's edge hold at the size of the ₹1 lakh a month goal?** (same workflow and Run button; iteration 12
   stays under its git tag) Iteration 12: ₹250–1000 all +0.12R (t 4.7, exam Pass) against the ₹250–340 control's −0.01R, but
   every liquidity floor halved it, so part of the edge sits in thinner stocks, where size hurts most.
   - The size: ~+0.15R a trade × ~30 trades a month → ₹1 lakh a month needs ~₹22,000 risk a trade, a ~₹10 lakh position.
   - Each trade priced at that size (`add_stress`): real fills + big-position charges (`nbS3 − nbS`: the same old fills at
     ~₹3 lakh and at ₹300 risk differ only in charges) − market impact `1.25 × √(order ÷ daily turnover)` R (square-root rule,
     0.5 × daily volatility per side, volatility ≈ usual range ÷ 1.6, on a stop of half the range). Thin stocks are not cut
     out; they cost what they would cost. Versions: ₹300 risk (`wAll`), ₹10 lakh (`wT10`, the test), ₹15 lakh (`wT15`, ₹1.5 lakh a month), ₹20 lakh (`wT20`); the goal is ₹1–1.5 lakh a month in total;
     the ₹250–340 control the same way (`nF`, `nT10`). Same model; the bar is set again on each version's costs.
   - ETFs left out of the dataset (`etfSymbols`: Dhan's instrument type, the fund name, the symbol; the run log lists them).
   - 2 a day and 2 a side set globally and checked on every trade after the run (`check_cap`; the job fails otherwise).
   - Rule fixed before the run (`wideVerdict`): `wT10` makes +0.04R, t ≥ 2, 150+ trades; its draw average beats `nT10`'s
     best draw; more R in total than `nT10`; exam profitable; placebo clean. All five, or not a candidate for Algo Live. The
     page also shows `wT10` in rupees a month at ₹10 lakh positions and the position ₹1 lakh a month would need.
14. **Which liquidity floor and how many trades a day pay at size?** (same workflow and Run button; iterations 12 and 13 stay
   under their git tags) Iteration 13: at ₹10 lakh positions +0.04R (t 1.5, exam Fail) from +0.17R before costs; the model
   picks thin stocks (~₹15–25 crore a day) and a ₹10 lakh order's impact eats the edge. Iteration 12's floors were priced at
   ₹300 risk, where liquidity barely matters; at size it does.
   - Every version priced at ₹10 lakh (job `wide`) or ₹5 lakh (job `wide5`): turnover floors in rupees (`minTurnover`:
     ₹17, 50, 100, 170, 250, 340, 500, 750, 1,000 crore a day) × 2, 3 and 4 trades a day (`cap`), plus size-aware picking
     (`aware`: each candidate's score cut by its own impact before ranking and the bar). One model per job; the bar still
     decides, the cap is a ceiling. `pools` = stocks clearing each floor on a typical day.
   - `check_cap`: every version's trades within its own cap (never above 4); the job fails otherwise.
   - Rule fixed before the run (`wideVerdict`, ₹10 lakh only): a cell is solid at +0.05R, t ≥ 2, 150+ trades, 50+ stocks a
     day and a profitable exam; a candidate if at least 2 neighbours (next floor at the same cap, next cap at the same floor)
     are profitable too; the candidate with the most R a month wins if its draw average beats `nT10`'s best draw, it makes
     more R a month than `nT10` and the placebo is clean. ₹5 lakh is shown, not judged.
   - The page's "~₹1 / 3 lakh position" rows use the old fills (no liquidity cost) and now say so.
15. **Does iteration 14's region hold as a block, at which size, and does a market gate fix 2026?** (same workflow and Run
   button; iteration 14 stays under its git tag) Iteration 14's pick (₹10 lakh, ₹100 crore+ a day, 4 a day: +0.08R, t 4.2)
   passed its rule, but the exam was weak (4 of 27 cells profitable; two of the pick's neighbours lost; Jul–Sep 2026 lost
   almost everywhere) and the neighbour check had been applied to the decide months only.
   - The block: ₹50, 100 and 170 crore a day x 3 and 4 a day (`FLOORS_CR`, `CAPS` in scripts/ml_wide.py). Job `wide`: the
     block at ₹10 lakh, the same block with the market gate (`_g`), and the placebo at ₹10 lakh / ₹100 cr / 4 a day, with the
     5 training draws. Job `ladder` (main draw only): the block at ₹5, 8, 12 and 15 lakh (`LADDER`), priced as in iteration 13.
   - Market gate (`hot_days`): the market's 20-day move = the median `ret20d` of every stock in the dataset at the day's first
     minute; a day is hot if that is above the top third of the 250 trading days before it (60 days of history at least).
     Fixed before the run, not tuned. Every version also reports its decide-month R by the third of that move
     (`regime`), the share of exam days that were hot, and how many decide days lost 2R / 3R+ (`badDays`). A daily loss stop
     is not modelled: the dataset has no exit times, so it would use results not yet known.
   - Rule fixed before the run (`wideVerdict`, `blocksOf`): a block (6 cells at one size, gated or not) holds if 5+ cells
     make +0.05R, t ≥ 2, 150+ trades on the decide months AND 4+ cells are profitable on the exam months. From the blocks that
     hold, the pick is the cell solid on its own (+0.05R, t ≥ 2, 150+ trades, 50+ stocks a day, exam profitable) making the
     most rupees a month at its size; it wins if the ₹10 lakh block's draw average (gated or not) beats `nT10`'s best draw,
     it makes more R a month than `nT10` and the placebo is clean. Otherwise Algo Live stays as it is. On iteration 14's
     numbers the ₹10 lakh block would not hold (2 of 6 cells profitable on the exam).
   - The workflow's tag now takes the iteration from scripts/ml_wide.py (iterations 13 and 14 were tagged `algo-iter-12-*`).

