# Algo Lab

**My Analysis → Algo Lab.** Machine learning the way algo desks test it, on every stock in his price range.

1. **Dataset** (lib/ml/grid.ts, written during the backtest job to `ml-data/`, never uploaded): every 10-min close
   09:35–14:45 of every stock-day in the universe (NSE, ₹250–340, 5 lakh+ shares average volume): 47 facts known at
   that moment (moves, VWAP, day range, tests of the high/low, candle shape, volume, Nifty 500, relative strength,
   EMAs, previous-day and value-area levels, volatility, price) and the result of a long and a short taken there:
   entry 1 tick worse than the close, stop 1 ATR, target 1.5 ATR (both on ticks, target only when traded through,
   same minute = stop), out by 15:00, Dhan's charges at ₹300 risk.
2. **Walk-forward models** (scripts/ml_walkforward.py, scikit-learn gradient-boosted trees): cross-sectional ranks
   added (this stock vs all others at the same minute). For each month: train on the 12 months before it, pick the
   "trade if predicted R above X" bar on the 2 months before it (with models that never saw them; stand aside if no
   bar was profitable), retrain, trade the month blind. One trade per stock per day, 10 a day at most.
3. **Results** (`setups/runs/<runId>/ml.json.gz`, scripts/ml-upload.ts): out-of-sample trades, R after costs, t,
   months green, ₹ per month at ₹300 risk, worst drop, by side and hour, what the model leans on, what its trades
   look like vs all moments, its latest trades.

Proven before use (tests/py/test_ml_walkforward.py): on pure noise it reports no edge; with a planted edge it finds it
out of sample, month after month, and names the planted facts. tests/ml.test.ts: every label matches an independent
replay of the bracket trade, no look-ahead in the facts, and the file Python reads is exactly what was written.
