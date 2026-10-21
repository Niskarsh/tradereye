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
   ~₹1 lakh / ~₹3 lakh with market orders, breakdowns on earlier months only** (this version).
