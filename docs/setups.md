# My Setups (backtest) and setup alerts

**My Analysis → My Setups** shows how 27 setups (10 combined, 17 building blocks) did over the last two years on the stocks his screener would have
shown each morning, with Dhan's charges taken off every trade. **Re-run** tests everything again; the page shows
what changed against the previous run. The **Order Book** page alerts on a setup only when its past numbers clear the bar.

## The setups (lib/setups/cases.ts)
Everything is decided on the **10-minute chart**: a setup appears only when a 10-minute candle closes, and the entry
is that close. 1-minute candles are used only to follow a trade (did the stop or the target come first inside a
10-minute candle).

**Combined (several conditions together, his way of trading):**
A momentum, Nifty-led · B momentum pullback (split by pullback number) · C momentum with relative strength ·
D reversal at the extreme · E reversal after a failed break (day high/low, previous day high/low, value area edge;
split by 1st / 2nd / 3rd+ test of the day's high/low, with the time of each test) · F reversal after exhaustion ·
G opening drive · I narrow candle at the extreme, then break · J divergence fade · K afternoon trend pullback.

Momentum context (A-C): Nifty 500 directional his way in the first 5 minutes and still his way open → now, the stock
busier than usual, no 200 EMA in the way, the stock 10-80% of its daily range his way.
Reversal context (D-F): a quiet stock, 50%+ of its daily range moved, Nifty flat or turning against the stock over
the last 30 minutes, no 200 EMA between price and the target.

**Building blocks (one condition each):** M1-M9 and R1-R8, so the page shows what each condition adds.

Stretch steps: momentum under 50 / 60 / 70 / 80%, reversal at least 50 / 60 / 70 / 80 / 90 / 95%.

## How a trade is scored (lib/setups/engine.ts)
- **Stop**: 0.1 ATR beyond the nearest solid swing on the 10-minute chart (today or yesterday): a swing low (high)
  that price moved away from by 0.75 ATR+, that was tested again (back within 0.25 ATR and rejected, closing back),
  and that no candle has closed beyond (or traded 0.15 ATR+ through) up to the entry. A solid swing beyond 2x ATR =
  the trade is not taken (counted as "skipped"). No solid swing = 2x ATR. R is measured from this stop.
- **Systematic exits**: 1R, 1.5R and the structural target (momentum 2R; reversal the POC / previous close / VWAP /
  other side of the opening range). Hit = target before stop.
- **Discretionary exits** (checked at each 10-minute close): X1 the candle closes beyond the previous one against
  you · X2 a candle against you with 2x normal volume · X3 Nifty 500 against you over the last 30 minutes · X4 the
  day's range reaches 95% of its usual · X5 the next obstacle (previous day high/low, 10m 200 EMA, POC, value area
  edge) · X6 under 0.3R after 30 minutes · X7 was +1R, back to +0.3R · XA the first of them. Hit = made money after
  charges.
- Stop and target in the same minute = stop. Anything open is closed at 15:00. Each setup fires at most once per
  stock, per day and side.
- Size = ₹300 / stop distance; Dhan's charges at that size are subtracted (lib/setups/costs.ts).
- The two years are split in half; "steady" means the hit rate holds in both.
- Every setup records the 30-minute slot it set up in.
- Order-book rejection cannot be backtested (no past order books): the alert says to confirm it on the book.

The live alerts run the same engine on today's candles so far (tests/setups.test.ts checks that a live run gives
exactly the backtest's signals up to that minute).

## The run (GitHub Actions)
Re-run → `POST /api/setups/run` leaves today's Dhan token in S3 under the run id and starts the
`Setup backtest` workflow (`.github/workflows/setups-backtest.yml`, `scripts/setups-backtest.ts`). The job overwrites
the token as soon as it has read it; the public log shows progress only.

1. Today's Nifty 500 list (NSE) mapped to Dhan ids; if the list cannot be downloaded, every NSE equity is used.
2. Daily candles per stock → the days it passed the screener (previous close ₹250–340, 10-day average volume > 3M).
3. 1-minute candles for those months only (plus 5 weeks before). Saved per stock-month under `setups/candles/1m/`;
   a finished month is never fetched again, so a re-run a month later fetches just the new month.
4. Results: `setups/runs/<runId>/summary.json.gz` and `signals-<case>.json.gz`, the list in `setups/runs/index.json`,
   progress in `setups/status.json`.

## Setup (one time)
GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
| --- | --- |
| `DHAN_CLIENT_ID` | Dhan client id (the token must belong to it) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | the same keys tradereye uses |
| `AWS_REGION` | the bucket's region, e.g. `ap-south-1` |
| `S3_BUCKET` | the bucket name (tradereye's `AWS_S3_BUCKET_NAME`) |

Vercel → Environment Variables (then redeploy):

| Name | Value |
| --- | --- |
| `GH_DISPATCH_TOKEN` | fine-grained GitHub token: only the tradereye repo, Repository permissions → Actions: Read and write |
| `SETUPS_ALERT_MIN_HIT` | optional, default `0.6`: the hit rate a bucket needs before the Order Book alerts on it |
| `GH_REPO` / `GH_REF` | optional, default `Niskarsh/tradereye` / `main` |

The workflow must be on `main` before the button can start it (GitHub only dispatches workflows on the branch named).
