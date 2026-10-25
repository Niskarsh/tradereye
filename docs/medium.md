# Medium trend radar (collector)

The first piece of the Medium page (Socials -> Medium, coming next): a collector that watches what is being published in
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
