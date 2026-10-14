import { READ_SCHEMA, SYSTEM_PROMPT, VERDICTS, type Verdict } from './prompt';

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
  verdict: Verdict | 'RAW'; lines: string[]; watch: string;
  /** A setup that fits the data better (only with MIXED / WARNING), with the app's own stop for it. */
  alternative?: Alt;
  model: string; inTokens: number; outTokens: number; costInr: number; latencyMs: number;
}

export class ClaudeError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ClaudeError'; }
}

export interface ClaudeOptions {
  apiKey: string; model?: string; usdInr?: number; timeoutMs?: number; thinking?: 'on' | 'off';
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
    // Sonnet 5.5 thinks by default, hidden, and thinking tokens count against max_tokens: that is what cut replies off
    // mid-JSON. The facts are pre-computed, so up-front thinking is turned off ("between_tools" is Sonnet 5.5's lowest
    // setting; "disabled" is rejected there). COPILOT_THINKING=on keeps the model's default thinking with a bigger budget.
    max_tokens: o.thinking === 'on' ? 4000 : 1000,
    ...(o.thinking === 'on' ? {} : { thinking: { type: 'between_tools' } }),
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    // structured outputs: the reply is guaranteed to be JSON that matches READ_SCHEMA
    output_config: { format: { type: 'json_schema', schema: READ_SCHEMA } },
    messages: [{ role: 'user', content: message }],
  };
  const t0 = now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? (o.thinking === 'on' ? 30_000 : 15_000));
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
    const content: { type: string; text?: string }[] = json?.content ?? [];
    const replyText = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
    const cutOff = json?.stop_reason === 'max_tokens';
    const parsed = Object.keys(parseReadFromText(replyText)).length ? parseReadFromText(replyText) : salvageRead(replyText);
    const v = String(parsed.verdict ?? '').trim().toUpperCase().replace(/\s+/g, '_');
    let verdict: Verdict | 'RAW' = (VERDICTS as readonly string[]).includes(v) ? (v as Verdict) : 'RAW';
    let lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map((l: unknown) => String(l)).filter(Boolean).slice(0, 3);
    let watch = String(parsed.watch ?? '');
    if (cutOff && verdict !== 'RAW' && lines.length && !watch) watch = '(reply was cut short; the lines above are complete)';
    // Never throw away a paid answer: if it did not parse, show Claude's text as it is.
    if (verdict === 'RAW' || !lines.length) {
      verdict = 'RAW';
      const why = json?.stop_reason === 'max_tokens' ? ' (cut off: answer too long)' : json?.stop_reason === 'refusal' ? ' (Claude declined)' : '';
      lines = [replyText ? replyText.slice(0, 800) : `Claude returned no text${why}.`];
      watch = why ? why.trim() : '';
    }
    const alternative = verdict === 'RAW' ? undefined : readAlternative(parsed.alternative);
    const u = json?.usage ?? {};
    return {
      verdict, lines, watch, model, alternative,
      inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outTokens: u.output_tokens ?? 0,
      costInr: costInr(model, u, o.usdInr ?? 88),
      latencyMs: now() - t0,
    };
  }
  throw new ClaudeError(529, 'Claude is overloaded right now. Try again in a moment.');
}

/** Fallback when the model answers in text: the first {...} that holds a verdict. */
export function parseReadFromText(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) return {};
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const o = JSON.parse(text.slice(start, end + 1));
      if (o && typeof o === 'object' && 'verdict' in o) return o as Record<string, unknown>;
    } catch { /* try a shorter span */ }
  }
  return {};
}

/**
 * A reply cut off mid-JSON (out of tokens): recover the verdict and every line that was written out in full,
 * so they are shown as normal lines instead of raw JSON.
 */
export function salvageRead(text: string): Record<string, unknown> {
  const v = text.match(/"verdict"\s*:\s*"([^"]+)"/);
  if (!v) return {};
  const out: Record<string, unknown> = { verdict: v[1] };
  const arr = text.match(/"lines"\s*:\s*\[([\s\S]*)/);
  if (arr) {
    const lines: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"\s*(?=[,\]])/g;
    let m: RegExpExecArray | null;
    const body = arr[1].split(']')[0] + (arr[1].includes(']') ? ']' : '');
    while ((m = re.exec(body))) { try { lines.push(JSON.parse(`"${m[1]}"`)); } catch { /* skip a broken line */ } }
    out.lines = lines;
  }
  const w = text.match(/"watch"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (w) { try { out.watch = JSON.parse(`"${w[1]}"`); } catch { /* ignore */ } }
  return out;
}

export interface Alt { direction: 'LONG' | 'SHORT'; setup: 'MOMENTUM' | 'REVERSAL'; stop?: number; reason: string }

function readAlternative(raw: unknown): Alt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const direction = String(o.direction ?? '').toUpperCase(), setup = String(o.setup ?? '').toUpperCase();
  if ((direction !== 'LONG' && direction !== 'SHORT') || (setup !== 'MOMENTUM' && setup !== 'REVERSAL')) return undefined;
  const stop = Number(o.stop);
  return { direction, setup, stop: Number.isFinite(stop) && stop > 0 ? stop : undefined, reason: String(o.reason ?? '') } as Alt;
}

/**
 * Keeps a suggested alternative only if it is one of the setups the app computed (an ALT line in the message), and
 * always replaces its stop with the app's own stop for that setup, so a stop can never be made up.
 */
export function checkAlternative(alt: Alt | undefined, message: string): Alt | undefined {
  if (!alt) return undefined;
  const m = message.match(new RegExp(`^ALT ${alt.setup} ${alt.direction}: stop (\\d+(?:\\.\\d+)?)`, 'm'));
  if (!m) return undefined;
  return { ...alt, stop: Number(m[1]) };
}
