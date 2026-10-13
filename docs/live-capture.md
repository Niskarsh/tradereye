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
