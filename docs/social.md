# YouTube and Instagram (Shorts and Reels)

The **Socials** page (`/socials`, signed in only; `/youtube` redirects there) connects the Candles Before Cubicles YouTube channel and Instagram
account once, makes Shorts and Reels from real trades, and (next) schedules them on both platforms.

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
  chart and takes every price from the candles themselves. Comment + Subscribe never move once shown. The live R counter is price R
  from his first stop; the result is the journal's R after charges (or the % move when no risk was logged). Only trades
  over 92 days old are offered: the ticker is shown, and SEBI wants price data in market education to be 3+ months old.
- **Me vs Algo:** one finished week (Mon-Fri) since Algo Live started. A trade is the algo's when an Algo Live order
  for that day, stock and side filled within 5 minutes of the journal trade's entry; everything else is his. Each side
  is scored by the journal's R (net after charges / RiskInr; the algo's order risk when RiskInr is missing). Trades with
  neither are not scored. Each panel replays that side's biggest-R trade of the week (usually two different stocks).
  The header says 10-MIN CHARTS. Tickers are shown from the first frame (no reveal) only when that trade is over 92 days
  old (SEBI's 3-month rule); recent weeks keep them hidden. Season
  table = weeks won per side. Opening line clears after 2 s, then both trades play. Result badges are honest: BOOKED (a win), STOPPED (only when the stop
  actually hit), CUT (a loss closed earlier). **Why beat:** once both trades are done, each side's one-line reason is
  shown and the candles it refers to are marked on that side's chart (Claude picks them, `toMarks` checks them), held
  5 s, before the week's totals; 3 s later the verdict ("I take the week." / "The bot takes the week." / "Dead even.",
  or "... sat out. Still won." when the winner made no trades) and the season score.
  **Season ledger** (`lib/shorts/season.ts`, S3 `shorts/season.json`): the first time a short uses a week, that week and
  every earlier finished week are frozen (both sides' R, trade counts, winner). The video's week totals and season score
  come only from frozen weeks, so a score shown to viewers never drifts when the journal changes later. The Me vs Algo
  tab shows each week as Frozen / Not frozen, the season so far, and warns when today's data would score a frozen week
  differently; **Re-score week** (`POST /api/shorts/season`) is the only way to change it, and keeps the old result in
  that week's history.

**Claude writes the words (optional, on by default):** at Generate, one Claude call per short (`lib/shorts/write.ts`,
`ANTHROPIC_API_KEY`, model `COPILOT_MODEL`) gets only real facts: the trade, the candles before and during it (entry
and exit marked), his journal comment and context columns. It returns the tell (mystery) or the two one-line reasons
(Me vs Algo), the YouTube title / description / tags and the Instagram caption, saved as `shorts/<id>/text.json`.
Anything he typed is used instead of Claude's tell / reasons. Reach rules in the prompt: title max 55 characters with
the hook in the first 40 (phones cut the rest), searchable words where natural, one easy comment question, the first
line of the description (100 chars) and caption (125 chars) carry the hook, YouTube exactly 3 hashtags (#shorts first),
Instagram 3-5. Instagram allows **5 hashtags at most**: `capHashtags` drops extras from Claude's caption and from his
edits. The mystery's ticker is kept out of every public text
(it is the reveal), and that is enforced in code too. If Claude fails, the short is still made, just without text.

Generate saves a spec to S3 (`shorts/<id>/spec.json`) and starts **Render short** (`.github/workflows/shorts-render.yml`,
needs `GH_DISPATCH_TOKEN` like the backtest). The job runs `scripts/shorts/render.py` (Pillow + ffmpeg, Inter font),
uploads `short.mp4` + `poster.jpg` and marks `status.json` done. The job's AWS key (repo secrets, same as the backtest)
needs read/write on `shorts/`. The page polls and shows the preview.

## Scheduling (each finished short: Schedule / Edit schedule)
The editor opens above the shorts: Claude's YouTube title, description, tags and Instagram caption (all editable), a
YouTube date/time and "Same time as YouTube" for Instagram (untick to give Instagram its own time, or untick a platform
to skip it). Times are IST. A short not scheduled yet is offered the next free **Mon / Wed / Fri** day, oldest short
first: **Instagram 11:00, YouTube 15:30 IST** (`nextSlotPairs`, `lib/shorts/slots.ts`).
YouTube extras on every upload: not made for kids (`selfDeclaredMadeForKids: false`), no altered / synthetic content
(`containsSyntheticMedia: false`), category **People & Blogs (22)** (a personal trade journal; deliberately not
Education), title / description / audio language English (US). **Risk disclaimer** (`lib/shorts/disclaimer.ts`): every
YouTube description and Instagram caption gets a SEBI risk disclaimer (not a registered adviser, not advice, high risk
of loss; mystery shorts add that prices are 3+ months old), inserted once above the closing hashtags, by code: on
Claude's text and again on every save, so edits cannot drop it. **Playlists:** the editor lists the channel's playlists
(`GET /api/social/playlists`); a new mystery short starts with the playlist whose name contains "Mystery", a Me vs Algo
short with the one containing "Algo". Adding / removing uses `playlistItems` (force-ssl scope; works while private). The plan for every short is one S3 file, `shorts/posts.json`
(`lib/shorts/posts.ts` rules, `lib/shorts/publish.ts` work); each card shows Scheduled / Live (link) / Failed.
- **YouTube:** uploaded when Schedule is pressed, private with `publishAt`; YouTube itself makes it public at that time,
  whatever tradereye is doing. A new time or new words change the upload; Unschedule removes it. Changing or removing
  needs the `youtube.force-ssl` scope: a channel connected before it was added shows "Connect again once".
- **Instagram:** the API cannot schedule or post privately, so tradereye publishes it, woken by **EventBridge
  Scheduler** (`lib/social/scheduler.ts`, signed with `lib/aws/sigv4.ts`). Each waiting Reel has exactly one one-time
  wake-up (`tr-ig-<short>-<minute>`, default group, deleted by AWS after it runs) at its next step. It invokes the Lambda
  **tradereye-social-timer** (`infra/social-timer/index.mjs`), which calls `POST /api/social/tick` with `CRON_SECRET`:
  20 minutes before the slot the video is handed to Meta (processed ahead, nothing visible), at the slot it is
  published once Meta says FINISHED (not yet: another wake-up 2 minutes later). Three failed tries in a row, or over 90
  minutes late, marks it Failed with **Post now** (publish at once, also the retry). Unscheduling or a new time removes
  the old wake-up. If a wake-up cannot be set, the post says "Timer not set" with AWS's reason.
  Cost: Scheduler 14M invocations / month free, Lambda 1M requests / month free; this uses ~30.
- A scheduled short cannot be deleted until it is unscheduled. Anything already public is never touched.
- Env (Vercel): `CRON_SECRET` (24+ random characters, same value in the Lambda), `SOCIAL_TIMER_LAMBDA_ARN`,
  `SOCIAL_TIMER_ROLE_ARN`. The S3 AWS key also needs `scheduler:CreateSchedule` / `scheduler:DeleteSchedule` on
  `schedule/default/tr-*` and `iam:PassRole` on the timer role. Lambda env: `TICK_URL`, `CRON_SECRET`.

## Posting view (Socials page, second tab)
Every short with a posting plan: **Needs attention** (failed, rejected by YouTube, timer not set), **Upcoming**
(soonest first, with a countdown), **Published, last 7 days** (with links). Each row has Edit (same editor). YouTube rows
are checked with YouTube itself (`videos.list`): public = live, rejected / failed / deleted = needs attention, still
private well after its time = flagged. `GET /api/shorts/posts`.
