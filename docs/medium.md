# Medium

## The Medium page (Socials -> Medium, `/socials/medium`, signed in only)
Medium's API is closed to new integrations and no browser automation is used: tradereye prepares an article from real
data and he pastes it into Medium and publishes by hand (Medium's own "Schedule for later" for timing).

1. **Format and period** (no Claude): Weekly trade log (a week's journal trades), Me vs Algo (a finished season week:
   its score comes only from the frozen ledger `shorts/season.json`, and choosing a week freezes it, exactly as a short
   does), Building tradereye (a range of kept Algo Lab iterations), Monthly review (a month's trades against the month
   before). `lib/medium/source.ts` loads, `lib/medium/material.ts` decides what goes in.
2. **Questions** (one Claude call, on the button): 4-5 pointed questions about that data. He answers by typing or
   dictating (Chrome speech recognition, `components/medium/Dictate.tsx`).
3. **Draft** (one Claude call, on the button, needs 3 answers of 15+ words): Claude only reorders, trims and adds short
   headings to HIS answers, plus the publish kit (title, subtitle, 5 tags, image captions). Editable inline.
4. **Images**, drawn in the browser from the article's data (`components/medium/render.ts`), each with its own PNG
   download: feature image (title over the article's own chart / bars, faint), trade charts (5-minute candles from the
   saved 1-minute ones, his entries / adds / exits via `tradeMarks`, his real stop only), equity curve, Me vs Algo
   scoreboard, Algo Lab exam bars. The draft marks where each goes with `[IMAGE <id>]`.
5. **Publish kit**: copy buttons for each field and for the whole article as rich text (headings, bold, lists survive
   Medium's paste). Suggested publication from settings.
6. **Published**: he pastes the story's link back; the list shows Draft / Published.

**Drafts** save themselves (answers, draft text, kit: 1.5 s after the last change, plus before any button that loads
or calls Claude; the page warns before closing with unsaved edits). An article stays a draft in the list until its
Medium link is pasted back, so it can be reopened and changed any time.

**Building tradereye as a series** (one article per Algo Lab iteration): pick the same iteration in From and To. The
kept ledger starts at iteration 5, so iterations 1-4 come from an old run's results file when one is still in the run
index, otherwise from `lib/medium/early.ts` (numbers copied from docs/algo-lab.md "Iterations"). A part gets a one-line
recap of every earlier iteration and the chart shows them all; the publish kit lists the earlier parts already
published ("Earlier in this series", copyable) so readers can start at part 1.

### Written for people who have never traded
Medium readers are mostly not traders. The data Claude gets is in plain words, with a glossary (R, charges, stop, short,
exam months, confidence score...) it must use to explain each term the first time. Versions are never letters
("Strategy A"): "the version it kept", "comparison version 1". Questions may never ask him for a number, date, month or
name (the data has all that is known); ones that do are dropped (`asksForFact`). The checks flag jargon a beginner would
not know when it is not explained in the same sentence (`jargonHits`). **Refresh data** reloads an article's data with
these rules, keeping its answers and draft.

### The guards (pure, `lib/medium/article.ts`, tested in `tests/mediumPage.test.ts`)
- **His words**: the page shows how much of the draft is his answers (3-word runs); under 80% it warns. Medium does
  not allow AI-written stories behind the paywall, and his Partner Program account is the asset.
- **Invented numbers**: numbers in the draft that are in neither the data nor his answers are flagged.
- **His edge**: Claude never gets journal context columns (setup, RVOL, ...), Algo Lab feature importance / "liked"
  features / thresholds / setup parameters, or strategy names (they become letters). Algo Lab "what changed" lines are
  unticked by default; only ticked ones reach Claude. **Secret terms** (settings) found in the draft, title, subtitle or
  captions block copying.
- **SEBI**: tickers of trades under 92 days old are "Stock A", "Stock B" everywhere (Claude never sees them); one in the
  text blocks copying. Tip / call / prediction phrases are flagged. The risk disclaimer is added by code at the end of
  every saved draft (plus "prices are 3+ months old" when every trade shown is). Lampshade of ILLUMINATION (an
  AI-only publication) can never be chosen.

### Storage (no Terraform change: the app key already reads / writes the whole bucket)
The bucket is publicly readable, so everything private is **encrypted** (AES-256-GCM, key from `AUTH_SECRET`, like the
YouTube / Instagram tokens; changing `AUTH_SECRET` makes them unreadable): `medium/articles/index.enc`,
`medium/articles/<id>/article.enc`, `medium/settings.enc` (publications, secret terms). Images are not stored. The app
key cannot delete objects, so Remove hides an article. APIs (all signed in): `GET/POST /api/medium/articles`,
`GET/PUT /api/medium/article?id=`, `POST /api/medium/questions`, `POST /api/medium/draft`, `GET/PUT /api/medium/settings`,
`GET /api/medium/periods`.

# Medium trend radar (collector)

A collector that watches what is being published in
Medium's trading tags, so articles can be angled at what is heating up. Nothing here calls Claude.

## How it collects (runs entirely in AWS)
Every 3 hours **EventBridge Scheduler** (schedule `tradereye-medium-collector`) runs the Lambda
**tradereye-medium-collector** (`infra/medium-collector/index.mjs`). The Lambda does all the work itself, so collecting
never depends on tradereye or Vercel being up:
- reads Medium's public RSS feeds in `FEEDS` (trading, day-trading, stock-market, algorithmic-trading, ...) at once;
  each feed holds only the ~10 newest stories and no clap counts
- adds every story to `medium/posts.json.gz` (title, author, link, publish time, its own tags, which feeds showed it,
  when it was first seen); stories older than 90 days are dropped
- logs the run in `medium/runs.json` (last 200 runs): per feed, stories shown, new, or the error. A feed whose stories
  were **all new** on a run is marked `full`: stories may have been missed between runs (run more often if common)

A run takes seconds. If every feed fails (e.g. Medium blocking AWS), the Lambda fails so it shows as an error.
The file formats are shared with `lib/medium/collect.ts` (tradereye's reading side): change both together.

## Checking it
`GET /api/medium/status` (signed in; open it in the browser): whether it is collecting, the last run per feed, stories
stored, and the tag trends so far. A wrong tag slug shows up as an error or 0 stories: fix it in `FEEDS` and run `terraform apply`
(infra/terraform). The Lambda's own logs: Lambda -> Monitor -> View CloudWatch logs.

## Trends (`trends()` in `lib/medium/collect.ts`)
Counts the tags on every stored story, last 7 days against the average week of the 3 weeks before (only weeks the
collector was running). `surge` = last week / usual week. Until one full baseline week exists, `ready` is false and only
last week's counts are given; it means something after about two weeks.

## AWS
Created and updated by Terraform: `infra/terraform/medium-collector.tf` (setup and commands in `infra/terraform/README.md`).
- Lambda `tradereye-medium-collector`: Node.js 22.x, code = `infra/medium-collector/index.mjs` (no packages; the AWS SDK
  is built in), timeout 1 min, env `BUCKET`. Its role: `s3:GetObject` / `s3:PutObject` on `<bucket>/medium/*`, `s3:ListBucket` (so a missing file reads as "not found"), plus logs.
- EventBridge Scheduler schedule `tradereye-medium-collector`: rate(3 hours), Asia/Kolkata, target that Lambda, payload `{}`.
- tradereye reads `medium/*` with its existing bucket access (`infra/terraform/app-user.tf`).
- Cost: 8 runs a day, inside the free tiers of Scheduler and Lambda.
