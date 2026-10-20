# My Setups (backtest) and setup alerts

**My Analysis → My Setups** shows how 17 setups did over the last two years on the stocks his screener would have
shown each morning, with Dhan's charges taken off every trade. **Re-run** tests everything again; the page shows
what changed against the previous run. The **Order Book** page alerts on a setup only when its past numbers clear the bar.

## The setups (lib/setups/cases.ts)
Momentum (Nifty 500 his way: before 09:30 by the first 5 minutes, from 09:30 by open → now):
M1 10-min opening range break · M2 30-min opening range break · M3 gap and go · M4 trend pullback that holds ·
M5 relative strength vs Nifty · M6 previous day high/low break that holds · M7 squeeze then expansion ·
M8 value area acceptance · M9 the same moments as M1/M2 with strong Nifty, but entered on a 0.5 ATR pullback.

Reversal: R1 overextension (50%+ of the daily range, turning in the day high/low zone) · R2 opening range failure ·
R3 gap fill · R4 volume climax then stall · R5 value area edge rejection · R6 previous day high/low rejection ·
R7 failed momentum (high rvol reversing: tests his skip rule) · R8 VWAP reversion (belief check).

Every trade is sliced by: side, time of day, Nifty first 5 minutes, Nifty open → trade, Nifty 30 minutes before the
trade, volume vs usual, rvol > 0.1 at 09:20, % of the daily range moved, 200 EMA in the way, stop capped, and which
other setups fired the same way in the 30 minutes before (combinations). The page lets him combine any of these.

## How a trade is scored (lib/setups/engine.ts)
- Only 1-minute candles complete at the decision minute are used; entry at the close of the minute before.
- 10-minute chart, ATR(14), the 200 EMAs (5m, 10m, 1D), VWAP and POC are computed like the co-pilot's.
- Stop: momentum beyond the last two 10-min candles (and the forming one); reversal beyond the day's extreme.
  At least 0.25 ATR, at most 2x ATR.
- Targets: 1R, 1.5R and the structural one (momentum 2R; reversal the POC / previous close / VWAP / other side of
  the opening range). The hit rate is quoted at 1R for momentum, at the structural target for reversals.
- Stop and target in the same minute = stop. Anything open is closed at 15:00. Each setup fires at most once per
  stock, per day and side.
- Size = ₹300 / stop distance; Dhan's charges at that size are subtracted (lib/setups/costs.ts).
- The two years are split in half; "steady" means the hit rate holds in both.
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
