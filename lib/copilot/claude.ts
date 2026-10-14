import { GIVE_READ_TOOL, SYSTEM_PROMPT, VERDICTS, type Verdict } from './prompt';

/**
 * One call to the Claude Messages API (plain fetch, no SDK). The API key is read on the server only and is never
 * sent to the browser. The system prompt is marked for prompt caching, so the morning's later checks pay less for it.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

/** USD per million tokens: input, output, cache write (5 min), cache read. From Anthropic's pricing page. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-sonnet-5-5': [2, 10, 2.5, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
  'claude-opus-5-5': [4, 20, 5, 0.2],
};

export interface ClaudeRead {
  verdict: Verdict; lines: string[]; watch: string;
  model: string; inTokens: number; outTokens: number; costInr: number; latencyMs: number;
}

export class ClaudeError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ClaudeError'; }
}

export interface ClaudeOptions {
  apiKey: string; model?: string; usdInr?: number; timeoutMs?: number;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
}

export function costInr(model: string, u: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }, usdInr: number): number {
  const [pi, po, pw, pr] = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const usd = ((u.input_tokens ?? 0) * pi + (u.output_tokens ?? 0) * po + (u.cache_creation_input_tokens ?? 0) * pw + (u.cache_read_input_tokens ?? 0) * pr) / 1e6;
  return Number((usd * usdInr).toFixed(3));
}

export async function askClaude(message: string, o: ClaudeOptions): Promise<ClaudeRead> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const model = o.model || DEFAULT_MODEL;
  const body = {
    model,
    max_tokens: 400,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [GIVE_READ_TOOL],
    tool_choice: { type: 'tool', name: 'give_read' },
    messages: [{ role: 'user', content: message }],
  };
  const t0 = now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await f(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') throw new ClaudeError(504, 'Claude did not answer within 15 seconds.');
      throw new ClaudeError(502, `Could not reach Claude: ${(e as Error).message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const type = json?.error?.type ?? '';
      // one retry, only when Claude is overloaded
      if ((res.status === 529 || type === 'overloaded_error') && attempt === 0) { await sleep(1500); continue; }
      const msg = json?.error?.message ?? text.slice(0, 200);
      if (res.status === 401) throw new ClaudeError(401, 'Claude rejected the API key. Check ANTHROPIC_API_KEY in Vercel.');
      if (res.status === 402 || /credit balance/i.test(msg)) throw new ClaudeError(402, 'Your Claude API credit has run out. Add credit at platform.claude.com.');
      if (res.status === 429) throw new ClaudeError(429, 'Claude is rate limiting. Try again in a few seconds.');
      throw new ClaudeError(res.status || 502, `Claude error: ${msg}`);
    }
    const block = (json?.content ?? []).find((c: { type: string; name?: string }) => c.type === 'tool_use' && c.name === 'give_read');
    const input = block?.input ?? {};
    const verdict = VERDICTS.includes(input.verdict) ? (input.verdict as Verdict) : undefined;
    if (!verdict) throw new ClaudeError(502, 'Claude answered in an unexpected shape.');
    const lines = (Array.isArray(input.lines) ? input.lines : []).map((l: unknown) => String(l)).filter(Boolean).slice(0, 3);
    const u = json?.usage ?? {};
    return {
      verdict, lines, watch: String(input.watch ?? ''), model,
      inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outTokens: u.output_tokens ?? 0,
      costInr: costInr(model, u, o.usdInr ?? 88),
      latencyMs: now() - t0,
    };
  }
  throw new ClaudeError(529, 'Claude is overloaded right now. Try again in a moment.');
}
