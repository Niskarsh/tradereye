/**
 * Starts the "Setup backtest" GitHub Action (workflow_dispatch). Needs GH_DISPATCH_TOKEN in Vercel: a fine-grained
 * token with access to this repo only and "Actions: Read and write".
 */
export const WORKFLOW_FILE = 'setups-backtest.yml';

export class DispatchError extends Error {
  constructor(public code: 'NO_TOKEN' | 'BAD_TOKEN' | 'NOT_FOUND' | 'FAILED', message: string) { super(message); }
}

export async function dispatchBacktest(runId: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  return dispatchWorkflow(WORKFLOW_FILE, { run_id: runId }, 'the backtest', env, fetchImpl);
}

/** Starts any workflow_dispatch workflow of this repo (same token and checks as the backtest). */
export async function dispatchWorkflow(file: string, inputs: Record<string, string>, what: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = env.GH_DISPATCH_TOKEN?.trim();
  if (!token) throw new DispatchError('NO_TOKEN', 'GH_DISPATCH_TOKEN is not set in Vercel (see My Setups → How to set up).');
  const repo = env.GH_REPO?.trim() || 'Niskarsh/tradereye';
  const ref = env.GH_REF?.trim() || 'main';
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status === 204 || res.ok) return;
  if (res.status === 401) throw new DispatchError('BAD_TOKEN', 'GitHub rejected GH_DISPATCH_TOKEN (expired or wrong). Make a new one and update it in Vercel.');
  if (res.status === 403) throw new DispatchError('BAD_TOKEN', 'GH_DISPATCH_TOKEN is missing the "Actions: Read and write" permission on the tradereye repo.');
  if (res.status === 404) throw new DispatchError('NOT_FOUND', `GitHub cannot find the workflow on "${ref}" (is the change merged to ${ref}?) or the token has no access to ${repo}.`);
  throw new DispatchError('FAILED', `GitHub answered HTTP ${res.status} when starting ${what}.`);
}
