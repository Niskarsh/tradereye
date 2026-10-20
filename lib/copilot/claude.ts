import { CHAT_RULES, READ_SCHEMA, SYSTEM_PROMPT, VERDICTS, type Verdict } from './prompt';

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
  /** Other ways to play it (only with MIXED / WARNING), each with the app's own stop. */
  scenarios: Scenario[];
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
  const json = await postMessages(body, o, f, sleep);
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
  const scenarios = verdict === 'RAW' ? [] : readScenarios(parsed.scenarios);
  const u = json?.usage ?? {};
  return {
    verdict, lines, watch, model, scenarios,
    inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0,
    costInr: costInr(model, u, o.usdInr ?? 88),
    latencyMs: now() - t0,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** POST to the Messages API with one retry when Claude is overloaded; returns the parsed JSON or throws a ClaudeError. */
async function postMessages(body: unknown, o: ClaudeOptions, f: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<any> {
  const limit = o.timeoutMs ?? (o.thinking === 'on' ? 30_000 : 15_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
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
      if ((e as Error).name === 'AbortError') throw new ClaudeError(504, `Claude did not answer within ${Math.round(limit / 1000)} seconds.`);
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
    return json;
  }
  throw new ClaudeError(529, 'Claude is overloaded right now. Try again in a moment.');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

export interface Scenario {
  kind: 'SETUP' | 'WAIT';
  setup?: 'MOMENTUM' | 'REVERSAL';
  direction?: 'LONG' | 'SHORT';
  stop?: number;
  /** Reversal only: the app's own target (VWAP / POC) for that setup. */
  target?: number;
  why: string;
  trigger: string;
}

function readScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw)) return [];
  const out: Scenario[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const kind = String(o.kind ?? '').toUpperCase() === 'SETUP' ? 'SETUP' : 'WAIT';
    const setup = String(o.setup ?? '').toUpperCase(), direction = String(o.direction ?? '').toUpperCase();
    const hasSetup = (setup === 'MOMENTUM' || setup === 'REVERSAL') && (direction === 'LONG' || direction === 'SHORT');
    const stop = Number(o.stop);
    out.push({
      kind: kind as Scenario['kind'],
      ...(hasSetup ? { setup: setup as Scenario['setup'], direction: direction as Scenario['direction'] } : {}),
      stop: Number.isFinite(stop) && stop > 0 ? stop : undefined,
      target: Number(o.target) > 0 ? Number(o.target) : undefined,
      why: String(o.why ?? ''), trigger: String(o.trigger ?? ''),
    });
  }
  return out.slice(0, 3);
}

/**
 * Keeps only scenarios the data supports, and never a made-up stop:
 *  SETUP must be an ALT line marked CORE MET; its stop is replaced by the stop in that line.
 *  WAIT with a setup takes the stop from its ALT line, or StopIdea when it is his own setup; otherwise no stop.
 *  WAIT without a setup is "stand aside".
 */
export function checkScenarios(list: Scenario[], message: string): Scenario[] {
  const header = message.match(/^Mode \w+ · [^·]+ · (LONG|SHORT) · (MOMENTUM|REVERSAL) ·/m);
  const ownStop = message.match(/"StopIdea":(\d+(?:\.\d+)?)/);
  const ownTarget = message.match(/"RoomTo":"(?:VWAP|POC|2-day POC) (\d+(?:\.\d+)?)"/);
  // reversal target from an ALT line: "room to VWAP 309.78 ..." / "room to POC 266.1 ..." / "room to 2-day POC ..."
  const altTarget = (line: string) => line.match(/room to (?:VWAP|POC|2-day POC) (\d+(?:\.\d+)?)/)?.[1];
  const out: Scenario[] = [];
  for (const sc of list) {
    if (!sc.setup || !sc.direction) {
      if (sc.kind === 'WAIT') out.push({ ...sc, stop: undefined, target: undefined });
      continue;
    }
    const line = message.match(new RegExp(`^ALT ${sc.setup} ${sc.direction}: stop (\\d+(?:\\.\\d+)?).*$`, 'm'));
    const own = header && header[1] === sc.direction && header[2] === sc.setup;
    if (sc.kind === 'SETUP') {
      if (!line || !/CORE MET/.test(line[0])) continue;
      const t = sc.setup === 'REVERSAL' ? altTarget(line[0]) : undefined;
      out.push({ ...sc, stop: Number(line[1]), target: t ? Number(t) : undefined });
    } else {
      const t = sc.setup !== 'REVERSAL' ? undefined : line ? altTarget(line[0]) : own && ownTarget ? ownTarget[1] : undefined;
      out.push({ ...sc, stop: line ? Number(line[1]) : own && ownStop ? Number(ownStop[1]) : undefined, target: t ? Number(t) : undefined });
    }
  }
  return out.slice(0, 3);
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ChatReply { text: string; model: string; inTokens: number; outTokens: number; costInr: number; latencyMs: number }

/**
 * Free chat about the trade: the same system prompt as the one-button read (cached and shared with it), then the chat
 * rules and the latest facts, then the conversation. Answers in plain text.
 */
export async function chatClaude(context: string, turns: ChatTurn[], o: ClaudeOptions): Promise<ChatReply> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const model = o.model || DEFAULT_MODEL;
  const body = {
    model,
    // short answers by design (he is watching a trade): the rules ask for under 60 words; this is the hard cap
    max_tokens: o.thinking === 'on' ? 3000 : 400,
    ...(o.thinking === 'on' ? {} : { thinking: { type: 'between_tools' } }),
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${CHAT_RULES}\n\n${context}`, cache_control: { type: 'ephemeral' } },
    ],
    messages: turns,
  };
  const t0 = now();
  const json = await postMessages(body, { ...o, timeoutMs: o.timeoutMs ?? 30_000 }, f, sleep);
  const content: { type: string; text?: string }[] = json?.content ?? [];
  let text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
  if (json?.stop_reason === 'max_tokens') text += text ? ' …(cut short: ask a narrower question)' : 'The answer ran too long. Ask a narrower question.';
  if (!text) text = json?.stop_reason === 'refusal' ? 'Claude declined to answer that.' : 'Claude returned no text.';
  const u = json?.usage ?? {};
  return {
    text, model,
    inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0, costInr: costInr(model, u, o.usdInr ?? 88), latencyMs: now() - t0,
  };
}

export interface StructuredReply { json: Record<string, unknown>; text: string; cutOff: boolean; model: string; inTokens: number; outTokens: number; costInr: number; latencyMs: number }

/** A one-off structured call (JSON schema), with the shared system prompt cached first and task rules after it. */
export async function structuredClaude(rules: string, message: string, schema: object, o: ClaudeOptions, maxTokens = 1500): Promise<StructuredReply> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const model = o.model || DEFAULT_MODEL;
  const body = {
    model,
    max_tokens: o.thinking === 'on' ? maxTokens + 3000 : maxTokens,
    ...(o.thinking === 'on' ? {} : { thinking: { type: 'between_tools' } }),
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: rules, cache_control: { type: 'ephemeral' } },
    ],
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: message }],
  };
  const t0 = now();
  const json = await postMessages(body, { ...o, timeoutMs: o.timeoutMs ?? 45_000 }, f, sleep);
  const content: { type: string; text?: string }[] = json?.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { parsed = parseReadFromText(text); }
  const u = json?.usage ?? {};
  return {
    json: parsed, text, cutOff: json?.stop_reason === 'max_tokens', model,
    inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0, costInr: costInr(model, u, o.usdInr ?? 88), latencyMs: now() - t0,
  };
}

/**
 * A plain call with its own system prompt (none of the trading co-pilot's), for tasks that are not trade advice:
 * the Order Book "Check feed" audit of Dhan's data. Plain text back.
 */
export async function plainClaude(system: string, message: string, o: ClaudeOptions, maxTokens = 1200): Promise<ChatReply> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const model = o.model || DEFAULT_MODEL;
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: message }] };
  const t0 = now();
  const json = await postMessages(body, { ...o, timeoutMs: o.timeoutMs ?? 45_000 }, f, sleep);
  const content: { type: string; text?: string }[] = json?.content ?? [];
  let text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
  if (json?.stop_reason === 'max_tokens') text += ' …(cut short)';
  if (!text) text = 'Claude returned no text.';
  const u = json?.usage ?? {};
  return {
    text, model,
    inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0, costInr: costInr(model, u, o.usdInr ?? 88), latencyMs: now() - t0,
  };
}

/**
 * A call with its own system prompt and a JSON schema for the answer (none of the co-pilot's prompt): the Reversal
 * Study's rule maker. Thinking is left at the model's default (it helps here), so maxTokens must be generous.
 */
export async function jsonClaude(system: string, message: string, schema: object, o: ClaudeOptions, maxTokens = 16_000): Promise<StructuredReply> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const model = o.model || DEFAULT_MODEL;
  const body = { model, max_tokens: maxTokens, system, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: message }] };
  const t0 = now();
  const json = await postMessages(body, { ...o, timeoutMs: o.timeoutMs ?? 240_000 }, f, sleep);
  const content: { type: string; text?: string }[] = json?.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* leave empty */ } } }
  const u = json?.usage ?? {};
  return {
    json: parsed, text, cutOff: json?.stop_reason === 'max_tokens', model,
    inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0, costInr: costInr(model, u, o.usdInr ?? 88), latencyMs: now() - t0,
  };
}
