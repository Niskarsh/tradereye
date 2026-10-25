// tradereye-medium-collector: the Lambda that EventBridge Scheduler wakes up every few hours for the Medium trend radar.
// It only calls tradereye's /api/medium/collect with the shared secret; tradereye reads the feeds and saves to S3.
// Runtime: Node.js 22.x. Environment variables: COLLECT_URL, CRON_SECRET. Timeout: 1 minute 30 seconds. No packages needed.
export const handler = async () => {
  const res = await fetch(process.env.COLLECT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(80_000),
  });
  const text = await res.text();
  console.log('tradereye answered', res.status, text.slice(0, 500));
  if (!res.ok) throw new Error(`tradereye answered ${res.status}`); // failing makes AWS retry
  return { status: res.status };
};
