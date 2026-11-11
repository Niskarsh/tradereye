# Algo Live

The strategy iteration 10 picked, traded with real money; from Dec 2026 the page can switch it to iteration 15's pick
(see "Iteration 15 (the wide model)" below).

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
- **To be certain nothing can trade today**: **Disarm + kill switch**, next to the arm button. It disarms first, then turns
  on Dhan's kill switch through trading-scaler, and shows ON only when Dhan itself reports it. It blocks the whole account
  for the day, hand orders too. Dhan refuses it while a position or pending order is open; the page then says it is
  disarmed but the switch is not on, and the button stays so you can try again after closing.

## Iteration 15 (the wide model), switched on from the page

Algo Live can trade either model; the top card of the page ("Which iteration") switches between them. Iteration 10 (narrow)
stays the default and is unchanged.

**Iteration 15** (`w10_f100_c3_g`, scripts/ml_live_wide.py): F as above, on ₹250–1000 stocks without ETFs, only those
trading ₹100 crore+ a day, at most 3 a day, and the **market gate**: no trades on a day the market's 20-day move (the
median 20-day move of every stock on the day list) is in the top third of its last 250 days. The bar was chosen on ₹10
lakh positions; live it trades the page's **Position a trade** (default ₹1.5 lakh). Standing aside when no bar made money
on the 3 months before is kept.

How it differs on the page:
- **Day list**: about twice as long, 5–15 minutes. When it is done the page shows the market gate. All stocks on it are
  scored and ranked (the model learned its ranks across all of them); only those over ₹100 crore a day can be traded.
- **The closes**: same times. A stock too thin to trade says so under its prediction.
- **Orders**: sized as rupees of stock (qty = position ÷ price), not by risk. ~2.3% stop → ₹1.5 lakh ≈ ₹3,500 risk.

### Each month (wide)
1. **Algo Lab → Run** (outside 08:40–11:15 on weekdays). Its dataset job builds the wide dataset (a few hours); the model
   jobs after it also score the new month as a shadow month.
2. Once the dataset job is done (Algo Lab says "Training the models"), press **Make this month's model** on Algo Live
   (switched to iteration 15) or run GitHub → Actions → **Algo Live model (wide)**. It takes the latest Algo Lab dataset
   (kept 7 days), trains this month's model exactly as the walk-forward did (tests/py/test_ml_live_wide.py proves the bar
   is the same), checks the live engine scores it and works out the gate exactly as Python, and saves it to
   `setups/live/model-wide.json.gz` (every month's kept under `setups/live/models-wide/`).
3. Each wide day list saves the day's market move (`setups/live/market-move.json`), so the gate still has its 250 days
   after the model's data ends. Days traded on the narrow model are missing from it: a few weeks change the bar very little.

### Switching (once, before the first wide day)
1. Make the wide model for the month (above).
2. trading-scaler on EC2 (docs/env.md): `BOT_MAX_PER_DAY=3` and `BOT_MAX_NOTIONAL` about 6% above the position size
   (₹1.5 lakh → `160000`), then restart it. Without this it refuses the third order and anything over ₹75,000.
3. Margin: 3 positions at ₹1.5 lakh need about ₹90,000 at Dhan's 5x.
4. On the page, before 08:45: switch to **Iteration 15 · wide** (it disarms), make the day list, check the gate line, arm.

Switching back works the same way. A switch is refused once a trade was sent that day. The rule we set for going live
(11 Nov 2026): switch on 1 Dec only if iteration 15's November was positive after costs, at ₹1–2 lakh positions; raise the
size only after about 100 real trades average +0.05R or better after costs. The pick itself stood aside in October and
November, so "its November" is what its never-stand-aside twin (`w10_f100_c3_g_ns`) traded in the Algo Lab run made after
30 Nov. Even after a switch the December model can stand aside (its bar is set on Sep–Nov): then it trades nothing.

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
