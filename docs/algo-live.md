# Algo Live

The strategy iteration 10 picked, traded with real money.

**F:** short only; stop ½ the usual daily range above the 10-minute close; target ½ of it below; out by 15:15. Entries
09:35–10:55, first come first served, at most 2 a day, ₹300 risk.

## Pieces

- **The model** (`scripts/ml_live.py`, GitHub workflow "Algo Live model"):
  - Trains the model that trades this month, exactly as the walk-forward did (30 months to learn from). The bar is set
    on the 3 months before, with the cap of 2 a day; if no bar made money there, it stands aside.
  - Exports the trees to `setups/live/model.json.gz` in S3.
  - Checks that both Python's walk of the exported trees and the live engine (`scripts/ml-live-check.ts`) reproduce
    scikit-learn. The run fails otherwise.
- **The engine** (`lib/algoLive/`):
  - `engine.ts`: the day list (the backtest's screener: previous close ₹250–340, 10-day average volume above 5 lakh)
    and each stock's history, saved once per day under `setups/live/<date>/`.
  - `features.ts`: at each 10-minute close, today's 1-minute candles go through `gridDay`, the same code that built the
    backtest's dataset. The rest of the day is filled flat. `tests/algolive.test.ts` proves the facts equal the
    backtest's.
  - `model.ts`: ranks across the list and the model's prediction.
  - The picks: clear the bar, not vetoed, at most 2 a day, stronger first.
- **The page** (My Analysis → Live Trading → **Algo Live**, `/algo/live`): drives the closes while it is open. It has
  the arm switch, the vetoes, the orders and a square-off button.
- **trading-scaler** (EC2, fixed IP; its `BOT.md`):
  - Places the orders as Dhan super orders (market entry, stop and target with it) and enforces its own guards: 2 a
    day, never the same order twice, 09:30–11:05 only, at most ₹75,000 a position.
  - Closes every bot position at 15:15.
  - Calls between the two apps are sealed with `TE_SHARED_SECRET` (`lib/algoLive/scaler.ts`), because they carry the
    Dhan token.

## Set up (once)

1. Merge both PRs (tradereye, trading-scaler).
2. Make a secret: `openssl rand -base64 32`.
3. **trading-scaler on EC2** (see its `BOT.md`):
   - set `TE_SHARED_SECRET`, `UI_PASSWORD` and `DHAN_CLIENT_ID`;
   - run `git pull && npm ci && npm run deploy`.
4. **Vercel (tradereye)**: set `TE_SHARED_SECRET` (the same value) and `TRADING_SCALER_URL` (for example
   `http://<EC2 IP>:3000`), then redeploy. The calls are sealed, so plain HTTP is safe.
5. The model for the month: GitHub → Actions → **Algo Live model** → Run workflow. It needs a backtest run from the
   last 7 days. At the start of each month, Re-run the backtest first, then this.

## Each morning

1. **08:45–09:10**:
   - log in on the Dhan login tab;
   - open Algo Live and press **Check trading-scaler** (it must say "up");
   - press **Make the day list** (1–3 minutes);
   - copy the list into Order Book → Start recording.
2. **09:25**: the shortlist appears on its own. Veto anything you don't want shorted (tick its box). A veto holds for
   the day.
3. **Arm** before 09:35 if you want the bot to trade. Not armed, it only shows what it would do.
4. **09:35–10:55**: each close runs 6 seconds after it.
   - A pick is sent within 4 minutes of its close or not at all.
   - At most 2 trades a day; a rejected order frees its place.
   - Keep the page open (a background tab is fine).
5. **15:15**: trading-scaler closes whatever is still open. The page does it again at 15:16 if it is open. **Square
   off now** closes everything at once.

## Protecting a trade by hand

Algo Live's orders table and the top of the Order Book page show two prices per trade: **90% at** and **Move stop to**,
the stop that still pays charges and usual slippage (`lib/algoLive/levels.ts`). Nothing moves on its own.

## If something goes wrong

- **The page shows an error at a close**: it tries again every 20 seconds until 4 minutes after the close.
- **"No live model" or "model for another month"**: run the Algo Live model workflow.
- **trading-scaler unreachable**: check pm2 on EC2 (`pm2 logs dhan-trading-bot`). Orders already placed keep their
  stop and target at Dhan.
- **To stop trading at once**: disarm the page. To close everything: Square off now, or close the positions in Dhan.

## Me vs Algo

The **Me vs Algo** card on My Setups (under Backtest vs live) lists every filled order: what the algo proposed, what you did (journal),
how far it got toward the target while you were in, and what the untouched stop and target would have done. It is read
only and uses data already kept (`lib/algoLive/meVsAlgo.ts`). Vetoed picks are not in it yet.

## Reviewing an Algo Live trade

"Review this trade" in the journal knows when Algo Live placed the trade (same stock, a short, sent within 10 minutes of
the first fill). It does not grade the entry, stop or target. It explains why the model took the stock and judges only
what you changed, by Me vs Algo's comparison.

The reasons are measured (`lib/algoLive/why.ts`): the engine's own `scoreAt` works out the whole list's facts at that
close again, each fact is swapped for other stocks' values, and the stock is re-scored. That is one Dhan request per
stock, so it is skipped until 11:05 on the trade's own day and saved under `setups/live/<date>/why/` afterwards. It reads
Algo Live's data and writes only that file; it places, changes and cancels nothing.
