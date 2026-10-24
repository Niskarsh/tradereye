# YouTube and Instagram (Shorts and Reels)

The **YouTube** page (`/youtube`, signed in only) connects the Candles Before Cubicles YouTube channel and Instagram
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

## How posting will work
- YouTube: uploaded right away as private with `publishAt`; YouTube makes it public at that time.
- Instagram: the API has no publish-at option, so tradereye creates the Reel container at the chosen time (containers
  expire after 24 hours), waits for FINISHED, then publishes.
