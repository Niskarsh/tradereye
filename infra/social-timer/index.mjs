// tradereye-social-timer: the Lambda that EventBridge Scheduler wakes up for each Instagram posting step.
// It only calls tradereye's /api/social/tick with the shared secret; tradereye does the rest.
// Runtime: Node.js 22.x. Environment variables: TICK_URL, CRON_SECRET. Timeout: 2 minutes. No packages needed.
export const handler = async (event) => {
  const res = await fetch(process.env.TICK_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(event ?? {}),
    signal: AbortSignal.timeout(110_000),
  });
  const text = await res.text();
  console.log('tradereye answered', res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`tradereye answered ${res.status}`); // failing makes AWS retry
  return { status: res.status };
};
