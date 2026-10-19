# Live capture and backfill

## Daily use
1. Generate your Dhan token as usual, open **Live**, paste it, press **Start session**.
2. Trade. Orders, stop moves, targets and fills are picked up (REST poll every 5s while a position is open, 15s when flat, plus the order WebSocket when Dhan allows it).
3. When a position goes flat the trade is written to the monthly sheet once. Press **End session** (or let it end when the token expires). **Renew** swaps a still-valid token for a fresh 24h one.

Open trades are shown on the Live page only. They are kept in the `live-trades` tab and are never written to the monthly sheets, so Journal and Stats never see a half-finished trade.

## Sheet changes (all automatic)
- Monthly tabs keep their 17 columns; extra columns are appended on the right the first time they are needed (`Source`, `InitialStop`, `RiskInr`, `ExitType`, `Nifty500First5Pct`, `RvolAtEntry`, `MfeR`, `Setup` ...).
- New tabs: `order-state`, `order-events`, `live-trades`.
- The manual "Fetch Today's Trades" flow is unchanged. If a trade is already in the sheet (by hand or automatic) it is not written again.

## Backfill
**Backfill** page: check, then start. It fills market columns for trades already in the sheet in small batches and can be stopped and resumed. It needs the Dhan Data API plan only while it runs. The `Setup` column is never touched.

## Environment (optional)
- `ALLOWED_DHAN_CLIENT_ID` - only accept tokens from this Dhan account on the new routes.
- `POSTBACK_SECRET` - enables `/api/live/postback?s=<secret>` for Dhan Postback.

## Tests
`npx tsx --test tests/*.test.ts`

## Stops that arrive late, and partial order-feed messages

The order feed can send partial messages (for example only the order id and a new trigger price). Missing fields are
never turned into defaults: they keep whatever the order book already told us, so a BUY stop on a short stays a BUY stop.
If a trade was logged before its stop was understood, the next sync fills the blank `InitialStop`, `InitialStopDist`,
`RiskInr`, `LastStop`, `StopMoves`, target and `ExitType` cells on that trade's rows (only blank cells; anything you typed is
left alone). The Live page shows the field names the order feed sends ("Order feed fields seen"), which makes a format
change easy to spot. After stops are filled, run Backfill with "Redo trades already filled" to get MFE/MAE in your real R.

## Sheets rate limit (429)
Google allows about 60 read requests per minute. A quiet refresh now costs 2 reads (header and tab lists are cached, tails are read in one batch), the page refreshes every 8s (open trade) or 20s (flat), the activity log every 30s, and order-feed frames are grouped for 2.5s. If Google still answers 429, the server retries briefly (honouring Retry-After) and the page pauses 30s and carries on; nothing is lost.

## Journal charts (daily + 10-minute, rebuilt from candles)
Each journal trade shows its own charts above the screenshot upload (which still works as before): daily candles on
the left (a month in view, about 2 years to drag back through; tap a day to open it on the 10-minute chart) and the
10-minute chart on the right with your entries / adds / exits, stop, target, 1R, VWAP, 200 EMA, the day's volume
profile and Nifty 500 underneath. Signals that fired while you were in are marked: 0.8R reached (and whether Nifty was
moving against you), half the peak given back, VWAP lost on heavy volume. Both charts drag, zoom (wheel, pinch, +/-)
and have a crosshair (tap on a phone); double-click or **Trade** goes back to the trade.

Candles are saved in the same S3 bucket, found from the stock and date alone (nothing in the sheet):
- `candles/1m/<year>/<month>/<SYMBOL>_<date>.json.gz` - one day of 1-minute candles (Nifty 500 as `NIFTY500_...`)
- `candles/daily/<year>/<month>/<SYMBOL>_<date>.json.gz` - about 2 years of daily candles ending that day

The first time a trade's charts open, the missing days come from Dhan (Data API plan, about 3 requests) and are saved;
after that they load from S3 only. Today is shown live and saved after 15:35. The AWS key needs `s3:GetObject` and
`s3:PutObject` on `candles/*` (like `order-book/*`); if a save fails the chart still shows and says so.
