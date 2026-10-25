# Environment variables and secrets: where every value lives

**Rule (for people and AI agents):** any change that adds, removes, renames, moves or rotates an environment variable
or secret must update this file in the same change, and its plan must list every place the value has to be set.
A value that lives in two places (see "Shared values") must be changed in both, or something breaks silently.

Vercel hides sensitive values once saved (they cannot be read back). Keep a copy of every secret in a password manager;
if a value is lost, make a new one and set it in every place listed here.

## Where values are set
| Place | How to change it |
|---|---|
| **Vercel** (tradereye app) | Project → Settings → Environment Variables, then **Redeploy** (values only apply to new deployments) |
| **GitHub Actions secrets** (repo Niskarsh/tradereye) | Settings → Secrets and variables → Actions |
| **Terraform** (`infra/terraform/terraform.tfvars`, local, not committed) | edit, then `terraform apply` (puts it into AWS, e.g. a Lambda's environment) |
| **Trade Assistant machine** (EC2, repo Niskarsh/trading-scaler) | that app's own environment on the machine |
| **Outside services** | Google Cloud console, Meta developer app, Dhan web, GitHub tokens page |

## Shared values (set in more than one place: change all of them together)
| Value | Places |
|---|---|
| `CRON_SECRET` | Vercel `CRON_SECRET` · Terraform `cron_secret` (→ Lambda `tradereye-social-timer` env) |
| `TE_SHARED_SECRET` | Vercel `TE_SHARED_SECRET` · Trade Assistant machine (same name there) |
| AWS key of user `trader-eye-journal-uploader` | Vercel `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` · GitHub secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| Bucket name | Vercel `AWS_S3_BUCKET_NAME` · GitHub secret `S3_BUCKET` · Terraform `bucket` |
| Region | Vercel `AWS_REGION` · GitHub secret `AWS_REGION` · Terraform `region` |
| Dhan client id | Vercel `DHAN_CLIENT_ID` (and `ALLOWED_DHAN_CLIENT_ID`) · GitHub secret `DHAN_CLIENT_ID` |
| Instagram timer ARNs | Vercel `SOCIAL_TIMER_LAMBDA_ARN` / `SOCIAL_TIMER_ROLE_ARN` · made by Terraform (`terraform output`) |
| Google OAuth client | Vercel `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` · Google Cloud console (sign-in + YouTube) |
| Instagram app | Vercel `IG_APP_ID` / `IG_APP_SECRET` · Meta developer app |
| `POSTBACK_SECRET` | Vercel `POSTBACK_SECRET` · the postback URL saved at Dhan (`...?s=<value>`) |

## Every variable
Secret = must never be committed, logged or shared. "Read by" lists the code that uses it.

### Vercel (tradereye app)
| Variable | Secret | Read by | What it is / how to rotate |
|---|---|---|---|
| `AUTH_SECRET` | yes | `lib/auth/session.ts`, `lib/auth/ownerSync.ts`, `lib/social/store.ts`, `lib/medium/articles.ts`, google login | signs sessions, **encrypts the saved YouTube/Instagram tokens** (S3 `social/*.enc`) **and the Medium articles and settings** (S3 `medium/**/*.enc`): changing it signs you out, means connecting YouTube and Instagram again, and makes saved Medium drafts and secret terms unreadable (publish or copy them out first) |
| `OWNER_EMAIL`, `OWNER_GOOGLE_ID` | no | `lib/auth/session.ts`, google login/callback | the only Google account allowed in |
| `APP_URL` | no | `lib/auth/google.ts`, `lib/social/oauth.ts` | optional fixed site address for OAuth redirects |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret: yes | `lib/auth/google.ts`, `lib/social/youtube.ts`, auth + youtube routes | Google OAuth client (sign-in and YouTube); rotate in Google Cloud console |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID` | key: yes | `lib/sheetsApi.ts`, sheets + analytics routes | Google Sheets journal access (service account key from Google Cloud) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret: yes | `lib/book/s3.ts`, `lib/shorts/store.ts`, `lib/social/store.ts`, `lib/social/scheduler.ts`, `app/api/upload` | key of IAM user `trader-eye-journal-uploader` (permissions in `infra/terraform/app-user.tf`). **Also in GitHub secrets.** Rotate: new key in IAM, set in both places, then delete the old key |
| `AWS_REGION`, `AWS_S3_BUCKET_NAME` | no | same files | the bucket (`infra/terraform/s3.tf`). Also in GitHub secrets and `terraform.tfvars` |
| `SOCIAL_TIMER_LAMBDA_ARN`, `SOCIAL_TIMER_ROLE_ARN` | no | `lib/social/scheduler.ts` | the Instagram timer Lambda and the role Scheduler uses (`terraform output`) |
| `CRON_SECRET` | yes | `app/api/social/tick` (checks it) | **also in Terraform `cron_secret`** (the Lambda sends it). Rotate: `openssl rand -hex 32` → Vercel + `terraform.tfvars` → redeploy + `terraform apply` |
| `IG_APP_ID`, `IG_APP_SECRET` | secret: yes | `lib/social/instagram.ts`, instagram routes | Meta app "Tradereye Publisher" |
| `YOUTUBE_CHANNEL_HANDLE`, `IG_USERNAME` | no | `lib/social/youtube.ts`, `lib/social/instagram.ts` | optional: the only channel / account posted to |
| `ANTHROPIC_API_KEY` | yes | `lib/copilot/claude.ts`, `lib/shorts/write.ts`, `lib/medium/write.ts`, copilot / book / study / journal / medium routes | Claude API key (platform.claude.com) |
| `COPILOT_MODEL`, `COPILOT_THINKING`, `COPILOT_DAILY_LIMIT`, `COPILOT_CHAT_LIMIT`, `COPILOT_RISK_INR`, `COPILOT_NIFTY_DIR_PCT`, `COPILOT_EMA_REACH_ATR`, `COPILOT_POC_ROWS`, `COPILOT_USD_INR` | no | `lib/copilot/settings.ts` (+ `lib/shorts/write.ts`, `lib/medium/write.ts`) | co-pilot settings, all optional |
| `GEMINI_API_KEY` | yes | `lib/book/ocr.ts` | order-book OCR; `GEMINI_MODEL` optional |
| `ALLOWED_DHAN_CLIENT_ID` | no | `lib/live/guard.ts`, totp + journal review routes | only Dhan tokens of this client id are accepted |
| `DHAN_CLIENT_ID`, `DHAN_MPIN` | MPIN: yes | `app/api/auth/totp` | make a Dhan token from a TOTP. `DHAN_CLIENT_ID` is also a GitHub secret |
| `POSTBACK_SECRET` | yes | `app/api/live/postback` | Dhan's webhook lock; also in the postback URL saved at Dhan |
| `GH_DISPATCH_TOKEN` | yes | `lib/setups/github.ts` | fine-grained GitHub token (tradereye, Actions read/write) to start backtests; `GH_REPO`, `GH_REF` optional |
| `SETUPS_ALERT_MIN_HIT` | no | setups page / scan / runs routes | optional alert threshold |
| `TRADING_SCALER_URL` | no | `lib/algoLive/scaler.ts`, algo-live state route | address of Trade Assistant |
| `TE_SHARED_SECRET` | yes | `lib/algoLive/scaler.ts` | seals calls to Trade Assistant; **must equal the value on the Trade Assistant machine** |

### GitHub Actions secrets (repo Niskarsh/tradereye)
| Secret | Used by | Same value as |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `setups-backtest.yml`, `algo-live-model.yml`, `shorts-render.yml` | Vercel's AWS key |
| `AWS_REGION` | same | Vercel `AWS_REGION` |
| `S3_BUCKET` | same (passed to jobs as `BUCKET` / `AWS_S3_BUCKET_NAME`) | Vercel `AWS_S3_BUCKET_NAME` |
| `DHAN_CLIENT_ID` | `setups-backtest.yml` | Vercel `DHAN_CLIENT_ID` |

Set inside the workflows, not secrets: `RUN_ID` (from the Re-run button), `ML_DIR`, `ML_FROM`, `SETUPS_ONLY`, `BUCKET`.

### Terraform (`infra/terraform/terraform.tfvars`, local only)
| Variable | Secret | Goes to |
|---|---|---|
| `region`, `bucket`, `vercel_iam_user` | no | which region / bucket / IAM user Terraform manages |
| `cron_secret` | yes | env `CRON_SECRET` of Lambda `tradereye-social-timer` (must equal Vercel's) |
| `aws_profile`, `ec2_region`, `medium_collector_rate` | no | optional |

`backend.hcl` (local): the private state bucket. Terraform's own AWS key lives only in `~/.aws/credentials`
(profile `tradereye-tf`), never in Vercel, GitHub or the repo.

### Lambda environments (set by Terraform, never by hand)
| Lambda | Variables |
|---|---|
| `tradereye-social-timer` | `TICK_URL` (fixed in `social-timer.tf`), `CRON_SECRET` (from `cron_secret`) |
| `tradereye-medium-collector` | `BUCKET` (from `bucket`) |
