# YouTube and Instagram (Shorts and Reels)

The **Socials** page (`/socials`, signed in only; `/youtube` redirects there) connects the Candles Before Cubicles YouTube channel and Instagram
account once, then posts Shorts and Reels from tradereye. This first part covers connecting and testing; generating
and scheduling shorts are built on the same page next.

## Connecting
- **YouTube** uses the same Google OAuth client as sign-in, plus the `youtube.upload` and `youtube.readonly` scopes.
  The consent screen must be **In production** (Audience page), otherwise Google expires the refresh token after 7 days.
  Google shows an "unverified app" warning once while connecting: Advanced → Go to TraderEye. The channel is a Brand
  Account: pick **Candles Before Cubicles** in the account picker. Any other channel is refused
  (`YOUTUBE_CHANNEL_HANDLE`, default `@CandlesBeforeCubicles`), so nothing can land on another channel.
- **Instagram** uses the Meta app "Tradereye Publisher" (Instagram API with Instagram Login), kept in Development mode
  with candlesbeforecubicles as its Instagram Tester. Only that account is accepted (`IG_USERNAME`, default
  `candlesbeforecubicles`). Its token lasts ~60 days; tradereye renews it when fewer than 20 days are left.

Redirect addresses registered with Google and Meta:
- `https://tradereye.candlesbeforecubicles.com/api/youtube/oauth/callback` (+ `http://localhost:3000/...` for dev)
- `https://tradereye.candlesbeforecubicles.com/api/instagram/oauth/callback`
- Meta's deauthorize and data deletion callbacks: `/api/instagram/deauthorize`, `/api/instagram/data-deletion`
  (public, accepted only when signed with `IG_APP_SECRET`; both delete the saved Instagram connection).

## Where the tokens live
In S3 under `social/youtube.enc` and `social/instagram.enc`, encrypted (AES-256-GCM) with a key derived from
`AUTH_SECRET`. Never in Vercel env vars, never sent to the browser. Changing `AUTH_SECRET` means connecting again.

## Env
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (already set for sign-in), `IG_APP_ID`, `IG_APP_SECRET` (the Instagram
app id and secret from Meta's "API setup with Instagram login" page, not the Facebook app id). Optional:
`YOUTUBE_CHANNEL_HANDLE`, `IG_USERNAME`.

## Testing the pipes
- **Test upload (private)** uploads `public/social/sample-short.mp4` to YouTube as private. Delete it in Studio after.
- **Test upload (not published)** sends the same video to Instagram and waits until Meta has processed it, without
  publishing (Reels cannot be private). The unpublished upload expires on its own within 24 hours.

## Making shorts (Make shorts, on the Socials page)
Pick up to 3 shorts in total across both tabs (any mix), each with its own tell / notes, then Generate them all (one
render job each). Every row opens to the journal's own chart of that trade (TradeCharts: entries, adds, exits, stop,
target), so an old trade can be recalled before writing its tell. Nothing blocks a trade or week from being used again.

Two templates, both drawn from real data only:
- **Chart in both templates:** the trade day's saved 1-minute candles, from 09:15 (or two hours before a late entry)
  to the 10-minute candle after the exit, drawn as **10-minute candles that form live**: price moves through each
  minute (a green minute dips to its low before its high, a red one the reverse; only O/H/L/C are known), the open
  candle's body and wicks follow it, with a live price tag, until its 10 minutes are over. Finished candles are exact.
- **Mystery chart:** one of his trades, replayed. Hook line held 5 s; fast-forward to the entry; "Long, short, or
  wait?" with a 5-second countdown; the trade plays. When it first goes 0.3R (or 0.15%) under water, "Most people bail
  right here." stays 5 s while the replay runs in slow motion, so those seconds show the dip. Then straight to "THE
  STOCK WAS" + drum roll, the ticker pops onto a gold band with the result above it, the tell box (max 2 lines, even
  padding), and a YouTube-style SUBSCRIBE button with @CandlesBeforeCubicles.
  **Losing trades** are shown just as fully, but nothing may suggest the call was right: the reveal pill always says
  "MY CALL: LONG/SHORT" (never "the answer"); the dip message becomes "The stop stays where it is."; the box is
  "WHAT I MISSED" (the warning sign visible on the 10-min candles before entry, or plainly "nothing warned" when there
  was none) instead of "THE TELL"; the closing line asks "Would you have taken it?". Claude's titles say it was a loss.
  **Recap** (when there is a tell): after the end card has been read, the tell box slides to the top, the result and
  ticker band clear, and the chart comes back with the ticker and date in the header, the whole trade drawn, the P&L
  under it, and 1-3 marks drawn one by one: rings on 10-minute highs / lows / closes (same kind joined by a line, e.g.
  falling highs) or a level line. Claude picks the candles (`marks` in its answer); `toMarks` keeps only candles on the
  chart and takes every price from the candles themselves. Comment + Subscribe never move once shown. Fast-forward to the entry, freeze, "Long, short, or wait?" countdown, reveal, the
  trade plays out with a live R counter (price R from his first stop), then the result (the journal's R after charges,
  or the % move when no risk was logged), a drum-roll build-up, and the ticker reveal: the symbol slams onto a
  full-width gold band and stays on screen (the header switches to it too) through the optional one-line "tell". Only trades over
  92 days old are offered: the ticker is shown, and SEBI wants price data in market education to be 3+ months old.
- **Me vs Algo:** one finished week (Mon-Fri) since Algo Live started. A trade is the algo's when an Algo Live order
  for that day, stock and side filled within 5 minutes of the journal trade's entry; everything else is his. Each side
  is scored by the journal's R (net after charges / RiskInr; the algo's order risk when RiskInr is missing). Trades with
  neither are not scored. Each panel replays that side's biggest-R trade of the week; tickers are never shown. Season
  table = weeks won per side.

**Claude writes the words (optional, on by default):** at Generate, one Claude call per short (`lib/shorts/write.ts`,
`ANTHROPIC_API_KEY`, model `COPILOT_MODEL`) gets only real facts: the trade, the candles before and during it (entry
and exit marked), his journal comment and context columns. It returns the tell (mystery) or the two one-line reasons
(Me vs Algo), the YouTube title / description / tags and the Instagram caption, saved as `shorts/<id>/text.json`.
Anything he typed is used instead of Claude's tell / reasons. The mystery's ticker is kept out of every public text
(it is the reveal), and that is enforced in code too. If Claude fails, the short is still made, just without text.

Generate saves a spec to S3 (`shorts/<id>/spec.json`) and starts **Render short** (`.github/workflows/shorts-render.yml`,
needs `GH_DISPATCH_TOKEN` like the backtest). The job runs `scripts/shorts/render.py` (Pillow + ffmpeg, Inter font),
uploads `short.mp4` + `poster.jpg` and marks `status.json` done. The job's AWS key (repo secrets, same as the backtest)
needs read/write on `shorts/`. The page polls and shows the preview.

## How posting will work
- YouTube: uploaded right away as private with `publishAt`; YouTube makes it public at that time.
- Instagram: the API has no publish-at option, so tradereye creates the Reel container at the chosen time (containers
  expire after 24 hours), waits for FINISHED, then publishes.
