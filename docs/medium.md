# Medium trend radar (collector)

The first piece of the Medium page (Socials -> Medium, coming next): a collector that watches what is being published in
Medium's trading tags, so articles can be angled at what is heating up. Nothing here calls Claude; it costs nothing to run.

## What it does
Every 3 hours **EventBridge Scheduler** (schedule `tradereye-medium-collector`) invokes the Lambda
**tradereye-medium-collector** (`infra/medium-collector/index.mjs`), which calls `POST /api/medium/collect` with
`CRON_SECRET` (the same secret as the Instagram timer). tradereye then (`lib/medium/collect.ts`):
- reads Medium's public RSS feeds for the tags in `FEEDS` (trading, day-trading, stock-market, algorithmic-trading, ...)
  at once; each feed holds only the ~10 newest stories and no clap counts (`lib/medium/rss.ts` reads them)
- adds every story to `medium/posts.json.gz` (title, author, link, publish time, its own tags, which feeds showed it,
  when it was first seen); stories older than 90 days are dropped
- logs the run in `medium/runs.json` (last 200 runs): per feed, stories shown, new, or the error. A feed whose stories
  were **all new** on a run is marked `full`: stories may have been missed between runs (run more often if that is common)

## Checking it
`GET /api/medium/status` (signed in; open it in the browser): whether it is collecting, the last run per feed, stories
stored, and the tag trends so far. A wrong tag slug shows up as an error or 0 stories: fix it in `FEEDS`.

## Trends (`trends()`)
Counts the tags on every stored story, last 7 days against the average week of the 3 weeks before (only weeks the
collector was running). `surge` = last week / usual week. Not meaningful until about two weeks of history: until one full
baseline week exists, `ready` is false and only last week's counts are given.

## AWS
- Lambda `tradereye-medium-collector`: Node.js 22.x, code from `infra/medium-collector/index.mjs`, timeout 1 min 30 s,
  env `COLLECT_URL` = `https://tradereye.candlesbeforecubicles.com/api/medium/collect`, `CRON_SECRET`.
- EventBridge Scheduler schedule `tradereye-medium-collector`: rate(3 hours), target that Lambda, payload `{}`.
- The S3 key tradereye uses (Vercel `AWS_ACCESS_KEY_ID`) needs `s3:GetObject` and `s3:PutObject` on `medium/*`.
- Cost: 8 runs a day, inside the free tiers of Scheduler, Lambda and Vercel.
