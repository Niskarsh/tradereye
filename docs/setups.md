# My Setups (backtest) and setup alerts

**My Analysis → My Setups** shows how 27 setups (10 combined, 17 building blocks) did over the last two years on the stocks his screener would have
shown each morning, with Dhan's charges taken off every trade. **Re-run** tests everything again; the page shows
what changed against the previous run. The **Order Book** page alerts on a setup only when its past numbers clear the bar.

## Delivery cases (lib/setups/swing.ts)
Daily candles, bought at a close and sold at a later close, long only, sized at his risk from the stop:
- **S1 5-day reversal**: down 7%+ in 5 sessions and 4%+ worse than Nifty; held 5 sessions; stop 2x daily ATR.
- **D1 Momentum 6 and 12 months** (the Nifty200 Momentum 30 scoring): each month-end the 10 best by 6- and 12-month
  return per unit of volatility; held to the next month-end; stop 3x daily ATR.
- **D2 Near the 52-week high** (George & Hwang): each month-end the 10 closest to their 52-week high; held a month.
- **D3 RSI(2) pullback in an uptrend** (Connors): above the 200-day average, 2-day RSI under 10; out on the first
  close above the 5-day average (10 sessions at most).
- **D4 Trend breakout**: close above the 55-day high and the 200-day average; out on a close below the 20-day low
  (60 sessions at most).

Dhan delivery charges used: brokerage ₹0; STT 0.1% on buy and sell; NSE transaction 0.00297%; SEBI ₹10/crore;
stamp duty 0.015% on the buy; DP charge ₹12.50 + GST per stock per day it is sold; GST 18% on transaction + SEBI + DP.

## His own trades
**Your own trades, same yardstick** (bottom of My Setups, `/api/setups/journal`) scores every journal trade: R = net
P&L ÷ his logged risk (RiskInr), R before costs, charges in R, hit = made money after charges, by month / setup /
entry time / exit / side. Trades without a logged stop are counted at ₹300 and shown separately.

## Research cases
- **L1 Last half hour follows the first** (Gao, Han, Li, Zhou, market intraday momentum): Nifty 500 0.1%+ in its
  first 30 minutes; at 15:00 trade the stocks that moved the same way; out at the 15:29 close.
- **L2 End-of-day reversal** (Baltussen, Da, Soebhag): at 15:00 buy a stock 1.5%+ worse than Nifty since the open
  (sell 1.5%+ better); out at the 15:29 close.
- **FB Breakout fade**: every breakout setup (A, G, I, M1, M2, M6, M7) taken the other way.
- **S1 5-day reversal** (short-term reversal, Jegadeesh / Lehmann): down 7%+ in 5 sessions and 4%+ worse than Nifty;
  bought at the close, sold 5 sessions later; stop 2x daily ATR; delivery charges; long only.
The opening range breakout is not tested on purpose: nothing is entered before the 09:25 close.

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

1. Every NSE equity in Dhan's instrument list. Each day only the ones with a previous close of ₹250-340 and a 10-day
   average volume of 500,000+ shares are tested; the 20 busiest in their first 10 minutes (1.5x usual or more) are
   marked "in play" (a slice). The 5-day reversal (S1) runs on the daily candles.
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
