# Reversal Study

**My Analysis → Reversal Study.** No rules decided in advance: the moves first, then the rules.

1. **Every possible entry** (lib/study/mine.ts): every 10-minute close (09:25–14:55) where the stock is down from the
   open by at least 0.2 of its usual daily range (up, for shorts), still on the far side of VWAP and within 1.5 ATR of
   its day low. Scored as: entry at that close, stop 0.1 ATR beyond the low (0.25–2 ATR), target VWAP or the open
   (separately), closed at 15:00 at the latest, Dhan's charges at ₹300 risk.
2. **Labels**: CLEAN = target before the stop; MESSY = stop first, target later; FAIL = target not reached by 15:00.
   Failures always stay in.
3. **42 facts known at that moment**: the fall, time, candle shape, volume, tests of the low, distance to VWAP / open,
   Nifty 500's first 5 minutes / day / last 30 minutes, EMAs, previous day and value area levels, volatility.
4. **Analysis** (lib/study/analyze.ts), per side and target:
   - how many stock-days had a clean reversal, and how far stocks fell before one (percentiles);
   - the fall in bands, and the best band on year 1 shown with its year 2;
   - every fact in five equal groups (year 1 edges): clean / messy / fail and R after costs, year 2 next to it;
   - rules: a beam search on **year 1 only** for up to 4 facts together, scored by average R after charges minus its
     standard error (cautious), at least 150 trades; each next rule searched on the stock-days earlier rules left;
   - every rule traded on **year 2** (the first matching moment of each stock-day), its ₹ per month at ₹300 risk, and
     the same with a 2 ATR stop; all rules together; which facts the rules share.

It is produced by the same backtest run (Re-run on My Setups) and saved as `setups/runs/<runId>/study.json.gz`.

## Explain (Claude)
Every section has an **Explain** button (and every fact a small one): one Claude call per press, never automatic.
The page sends only which part (`/api/study/explain`: run, part, tab, item, optional follow-up question); the server
builds the message from the saved study (lib/study/explain.ts): a key to the terms, the tab's baseline and that part's
numbers as plain lines. Claude answers like he is five, in four steps: what it is, what the numbers say, what it means,
what to look at next. Answers are kept in the browser per run and part, so reopening costs nothing.
A "What the numbers mean" panel and a "How to read it" line under each table explain every column without Claude.
