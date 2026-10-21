# Algo Lab iterations

How each iteration is kept so we can always go back:

- **Code:** each run is tagged `algo-iter-<n>-<run id>` on GitHub by the workflow. Iteration 5, which ran before the
  tags existed, is the branch `algo-iter-5` (commit 1ae5f27). Each result also records its commit (`code` in ml.json).
- **Results:** `setups/ml/iterations.json` in S3 is the ledger (iteration, run, code, headline per strategy, R at each
  position size). `setups/ml/iterations/<n>/<run id>.json.gz` is the full result, including every out-of-sample trade.
  Neither is ever pruned. The Algo Lab page's "Iterations so far" reads the ledger.
- **To go back to iteration n:** branch from its tag or branch, merge that code to main, and Re-run.

All numbers below are out of sample, after Dhan's charges, at ₹300 risk (wide bracket: stop ½ the usual daily range,
target ¾, out by 15:15). "Earlier" is the months before May 2026; "exam" is May–Oct 2026.

| # | Best strategy | R / trade | t | Months green | Earlier | Exam | Signal | What we learned |
|---|---|---|---|---|---|---|---|---|
| 1 | Tight bracket (1 ATR) | −0.20 | −4.7 | 1/9 | – | – | – | Costs (~0.13% a round trip) kill tight stops |
| 2 | Wide bracket | −0.01 | −0.7 | 13/31 | −0.02 | +0.05 | 0.040 | Costs fixed; real but small signal; leans on Nifty |
| 3 | Wide, no Nifty facts | −0.00 | −0.1 | 15/31 | +0.01 | −0.12 | 0.079 | Nifty facts were noise; memory facts lead |
| 4 | Wide, stock facts only | +0.02 | 1.0 | 19/35 | +0.02 | −0.05 | 0.077 | First green; shorts carry it; limit orders lose |
| 5 | **Shorts only** | **+0.03** | **1.9** | **25/40** | **+0.03** | **+0.05** | 0.085 | ₹1 lakh positions: +0.04R (t 2.5); ₹3 lakh: +0.06R (t 3.4) |
| 6 | (shorts also at 09:25) | | | | | | | running |

Iteration 5's shorts: mostly at 09:35, in volatile stocks that ran up over 5 and 20 days, made the day's high in
the first 20 minutes and are already 1.6 ATR below it.
