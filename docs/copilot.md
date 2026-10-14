# Co-pilot

A second pair of eyes before (and during) a trade. Claude never decides and never says buy or sell.

## Daily use
1. Open **Co-pilot** (same Dhan token as the Live page). The top strip shows the Nifty 500 state and your day.
2. Tap **LONG / SHORT**, **MOMENTUM / REVERSAL**, then a symbol chip or type a symbol (optional: your stop).
3. The **Facts card** appears in 1-2 s. This step never calls Claude. Red lines are your own hard rules being broken.
4. Press **Ask Claude** for a read: Supports / Mixed / Warning, up to three lines and one thing to watch.
   Then tap **Took it** or **Skipped**.
5. Already in the position? The same button reads **Re-check my trade** and Claude answers Hold steady / Weakening / Warning.
   Your position, average price and pending stop are read from Dhan at that moment, so the Live page does not need to be open.

Keep the **Live** page running as usual: when it logs the trade, the entry check and any re-checks are copied onto the
trade's rows in the monthly sheet (the `Ck...` and `Rc...` columns) and shown as a badge in the Journal.

## What is stored
- `october-2026-checks` (one tab per month): every check, taken or skipped: the facts, Claude's read, tokens and cost,
  your decision, the trade it became, and the exact message sent to Claude (`PayloadJson`).
  Journal and Stats only read tabs named exactly `october-2026`, so they never see it.
- Monthly tabs get `Ck...` / `Rc...` columns (the check, copied on when the trade is logged) and market-context columns
  (`OrHigh`, `EntryVsOr`, `Ema200_1dAtr`, `PocDistAtr`, ...) that **Backfill** fills for every trade, old ones included.
- **Backfill → Fill check outcomes** adds, for every check older than 30 minutes, the best and worst move in R over the
  next 30 minutes and whether the stop would have been hit (`AfterMfeR30`, `AfterMaeR30`, `AfterHitStop`).

## How the numbers are made
The co-pilot reuses the journal's own calculations (`lib/live/enrich.ts`), so relative volume (TradingView style),
ATR(14) on 10-minute bars, VWAP and the Nifty 500 moves are identical to the journal's. Only candles completed before
the current minute are used; bars are aligned at 09:15; no 09:15 candle means blank, never a guess.
The daily 200 EMA uses about 5 years of daily candles and is left blank if the history shows a one-day move over 30%
(a likely unadjusted split or bonus). **POC is approximate** until checked against your TradingView volume profile
(`COPILOT_POC_ROWS` should match its row setting).

## Settings (Vercel environment variables)
| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required for Ask Claude. From platform.claude.com. |
| `COPILOT_MODEL` | `claude-sonnet-5-5` | `claude-haiku-5-5` is ~20x cheaper, judges less well. |
| `COPILOT_DAILY_LIMIT` | 25 | Asks per day. Facts still work past it. |
| `COPILOT_RISK_INR` | 300 | Fallback only. Your max risk per trade is set on the Co-pilot page (tap "Risk ₹300 per trade") and kept in the `copilot-settings` tab. |
| `COPILOT_NIFTY_DIR_PCT` | 0.15 | First-5-minute Nifty 500 move (%) that counts as directional. |
| `COPILOT_EMA_REACH_ATR` | 2 | A 200 EMA this close (in ATR) in the trade's path is flagged. |
| `COPILOT_POC_ROWS` | 30 | Volume profile rows across the day's range (match TradingView Session Volume Profile "Number of rows"). |
| `COPILOT_USD_INR` | 88 | Only for showing the cost of each ask in rupees. |
| `COPILOT_THINKING` | off | `on` lets Claude think before answering: slower and costlier; the facts are already computed, so off is the default. |

## Cost
About ₹1 per ask on Sonnet 5.5 (about 5,000 tokens in, 300 out). The cost of every ask is in the `CostInr` column.
