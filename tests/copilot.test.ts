import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candles } from '../lib/dhan';
import { computeEnrichment, toSessions } from '../lib/live/enrich';
import {
  climax, computeFacts, computeManageFacts, ema, failedBreak, hasSuspectGap, nMinuteBars, niftyState, pointOfControl, pullbackNumber,
  type FactsInput,
} from '../lib/copilot/features';
import { computeBehaviour, summarizeTrades, chargeRate } from '../lib/copilot/behaviour';
import { matchChecks, monthlyColumns } from '../lib/copilot/store';
import { buildMessage, SYSTEM_PROMPT } from '../lib/copilot/prompt';
import { askClaude, costInr } from '../lib/copilot/claude';
import { IST } from './helpers';

/* ---- fixtures -------------------------------------------------------------------------------------------- */

type B = { o: number; h: number; l: number; c: number; v?: number };
function day(date: string, bar: (m: number) => B, until = 375): Candles {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let m = 0; m < until; m++) {
    const b = bar(m);
    c.t.push(IST(date, '09:15:00') / 1000 + m * 60); c.o.push(b.o); c.h.push(b.h); c.l.push(b.l); c.c.push(b.c); c.v.push(b.v ?? 1000);
  }
  return c;
}
const merge = (...cs: Candles[]): Candles => ({ t: cs.flatMap((c) => c.t), o: cs.flatMap((c) => c.o), h: cs.flatMap((c) => c.h), l: cs.flatMap((c) => c.l), c: cs.flatMap((c) => c.c), v: cs.flatMap((c) => c.v) });
const PRIOR = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const calm = PRIOR.map((d) => day(d, (m) => ({ o: 300, h: 300.6, l: 299.4, c: 300 + Math.sin(m) * 0.2 })));
const dailyFlat = (n: number, px = 300): Candles => {
  const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i++) { c.t.push(IST('2021-01-04', '00:00:00') / 1000 + i * 86400); c.o.push(px); c.h.push(px + 3); c.l.push(px - 3); c.c.push(px); c.v.push(1e6); }
  return c;
};
// trade day: opens at 300, trends up to ~306 by 09:35 on rising volume
const trend = day('2026-10-12', (m) => ({ o: 300 + m * 0.3, h: 300.5 + m * 0.3, l: 299.8 + m * 0.3, c: 300.3 + m * 0.3, v: 2000 + m * 50 }), 40);
const niftyUp = day('2026-10-12', (m) => ({ o: 24000 + m * 5, h: 24003 + m * 5, l: 23998 + m * 5, c: 24004 + m * 5 }), 40);

const base = (over: Partial<FactsInput> = {}): FactsInput => ({
  date: '2026-10-12', nowMs: IST('2026-10-12', '09:30:20'), price: 304.6, direction: 'LONG', setup: 'MOMENTUM',
  stock1m: merge(...calm, trend), nifty1m: niftyUp, daily: dailyFlat(800), riskInr: 300,
  niftyDirPct: 0.15, emaReachAtr: 2, pocRows: 24, ...over,
});

/* ---- the rules carried over from the journal fixes -------------------------------------------------------- */

test('facts use the journal numbers: rvol (TradingView), ATR 10m and Nifty moves equal computeEnrichment at that moment', () => {
  const inp = base();
  const f = computeFacts(inp);
  const e = computeEnrichment({ date: inp.date, entryMs: inp.nowMs, exitMs: inp.nowMs, direction: 'LONG', entryPrice: inp.price, stock: toSessions(inp.stock1m), nifty: toSessions(inp.nifty1m), prevClose: 300 });
  assert.equal(f.RvolDay, e.rvolDayAtEntry);
  assert.equal(f.Atr10m, e.atr10m);
  assert.equal(f.NiftyFirst5Pct, e.nifty500First5Pct);
  assert.equal(f.NiftyNowPct, e.nifty500AtEntryPct);
  assert.ok(f.RvolDay! > 0 && f.RvolDay! < 1, `rvol ${f.RvolDay} is a share of a full day`);
});

test('no hindsight: candles from the as-of minute onward change nothing', () => {
  const quiet = day('2026-10-12', (m) => (m < 15 ? { o: 300 + m * 0.3, h: 300.5 + m * 0.3, l: 299.8 + m * 0.3, c: 300.3 + m * 0.3, v: 2000 } : { o: 304, h: 304.2, l: 303.9, c: 304, v: 2000 }), 40);
  const wild = day('2026-10-12', (m) => (m < 15 ? { o: 300 + m * 0.3, h: 300.5 + m * 0.3, l: 299.8 + m * 0.3, c: 300.3 + m * 0.3, v: 2000 } : { o: 304, h: 340, l: 270, c: 304, v: 900000 }), 40);
  const at = IST('2026-10-12', '09:30:40'); // minute 15 is still forming: it must not count
  const a = computeFacts(base({ nowMs: at, stock1m: merge(...calm, quiet) }));
  const b = computeFacts(base({ nowMs: at, stock1m: merge(...calm, wild) }));
  assert.deepEqual(a, b);
});

test('no 09:15 candle: opening range and moves from the open stay blank instead of being guessed', () => {
  const late = day('2026-10-12', (m) => ({ o: 300 + m * 0.3, h: 300.5 + m * 0.3, l: 299.8 + m * 0.3, c: 300.3 + m * 0.3 }), 40);
  for (const k of Object.keys(late) as (keyof Candles)[]) late[k] = late[k].slice(1); // starts at 09:16
  const f = computeFacts(base({ stock1m: merge(...calm, late) }));
  assert.equal(f.OrHigh, undefined);
  assert.equal(f.RsVsNiftyPct, undefined);
  assert.equal(f.ExtAdrPct, undefined);
  assert.ok(f.missing.some((m) => m.startsWith('first 10-min candle')));
});

test('opening range only after 09:20, then ABOVE/INSIDE/BELOW', () => {
  assert.equal(computeFacts(base({ nowMs: IST('2026-10-12', '09:19:30') })).OrHigh, undefined);
  const f = computeFacts(base());
  assert.ok(f.OrHigh !== undefined && f.OrLow !== undefined);
  assert.equal(f.EntryVsOr, 'ABOVE');
});

test('EMA matches the closed form on a constant series and refuses short histories', () => {
  assert.equal(ema(new Array(600).fill(5), 200), 5);
  assert.equal(ema(new Array(599).fill(5), 200), undefined);
  // 5-minute bars are session-aligned at 09:15
  const s = toSessions(trend);
  const fives = nMinuteBars(s, 5);
  assert.equal(new Date(fives[0].start * 1000 + 330 * 60000).toISOString().slice(11, 16), '09:15');
  assert.equal(fives[1].start - fives[0].start, 300);
});

test('daily 200 EMA needs long history and is blanked after a suspected split', () => {
  const ok = computeFacts(base({ daily: dailyFlat(800) }));
  assert.ok(ok.Ema200_1dAtr !== undefined);
  const short = computeFacts(base({ daily: dailyFlat(300) }));
  assert.equal(short.Ema200_1dAtr, undefined);
  const split = dailyFlat(800); split.c[400] = 150; // a 50% one-day drop
  assert.ok(hasSuspectGap(split));
  const f = computeFacts(base({ daily: split }));
  assert.equal(f.Ema200_1dAtr, undefined);
  assert.ok(f.missing.some((m) => m.includes('split')));
});

test('a 200 EMA just above a long is flagged as in the path', () => {
  const f = computeFacts(base({ daily: dailyFlat(800, 305.2) })); // daily EMA ~305.2, price 304.6
  assert.match(f.Ema200InPath, /1D/);
  assert.ok(f.flags.some((x) => x.includes('200 EMA')));
});

test('stop wider than 2x ATR is flagged and size is capped by the risk limit', () => {
  const f0 = computeFacts(base());
  const wide = computeFacts(base({ plannedStop: 304.6 - f0.Atr2! * 1.5 }));
  assert.ok(wide.flags.includes('Stop wider than 2x ATR'));
  const tight = computeFacts(base({ plannedStop: 303.6 }));
  assert.equal(tight.StopDist, 1);
  assert.equal(tight.SizeQty, 300);
  assert.ok(tight.RiskInr! <= 300);
  const wrong = computeFacts(base({ plannedStop: 306 }));
  assert.ok(wrong.flags.includes('Stop is on the wrong side of the price'));
});

test('POC sits where the volume traded', () => {
  const bars = [
    { t: 0, o: 100, h: 101, l: 100, c: 101, v: 100 },
    { t: 60, o: 105, h: 106, l: 105, c: 105.5, v: 10000 },
    { t: 120, o: 110, h: 110, l: 109, c: 109, v: 100 },
  ];
  const poc = pointOfControl(bars, 20)!;
  assert.ok(poc > 104.9 && poc < 106.1, `poc ${poc}`);
});

test('pullbacks, climax and failed breaks', () => {
  const up = [100, 102, 101, 103, 101.5, 104].map((c, i) => ({ t: i * 60, o: c, h: c + 0.2, l: c - 0.2, c, v: 1 }));
  assert.equal(pullbackNumber(up, 1, 1), 2);
  const spike = { t: 600, o: 100, h: 105, l: 99.9, c: 100.2, v: 5000 };
  assert.match(climax([spike], 1000, 720), /^TOP/);
  const prior = [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }];
  const win = [{ t: 60, o: 100.5, h: 102, l: 100, c: 100.8, v: 1 }, { t: 120, o: 100.8, h: 101, l: 100, c: 100.5, v: 1 }];
  assert.equal(failedBreak(prior, win, 100.5), 'HIGH');
  assert.equal(failedBreak(prior, win, 101.5), '');
});

test('Nifty state', () => {
  assert.equal(niftyState(0.3, 0.4, 0.05, 0.15, 570), 'TRENDING_UP');
  assert.equal(niftyState(0.3, 0.2, -0.05, 0.15, 570), 'FADING_UP');
  assert.equal(niftyState(0.3, -0.1, -0.2, 0.15, 570), 'FLIPPED');
  assert.equal(niftyState(0.05, 0.1, 0.05, 0.15, 570), 'FLAT');
  assert.equal(niftyState(undefined, undefined, undefined, 0.15, 557), 'OPENING');
});

test('in-trade facts: R, giveback, counter-volume and Nifty since entry', () => {
  // long at 303 (09:25), price rose to 306 then back to 304.5
  const path = day('2026-10-12', (m) => {
    const c = m < 10 ? 300 + m * 0.3 : m < 20 ? 303 + (m - 10) * 0.3 : 306 - (m - 20) * 0.15;
    return { o: c, h: c + 0.1, l: c - 0.1, c: m >= 20 ? c - 0.05 : c + 0.05, v: m >= 20 ? 4000 : 1000 };
  }, 31);
  const r = computeManageFacts({
    date: '2026-10-12', nowMs: IST('2026-10-12', '09:45:30'), price: 304.5, direction: 'LONG',
    stock1m: merge(...calm, path), nifty1m: niftyUp, avgEntry: 303, entryMs: IST('2026-10-12', '09:25:10'),
    initialStop: 302, currentStop: 302.5, atr10m: 1,
  });
  assert.equal(r.OpenR, 1.5);
  assert.ok(r.BestR! >= 3, `best ${r.BestR}`);
  assert.ok(r.GivebackR! > 1.4);
  assert.ok(r.CounterVolRatio! > 1, `counter ${r.CounterVolRatio}`);
  assert.ok(r.NiftySinceEntryPct! > 0);
  assert.equal(r.MinInTrade, 20);
});

/* ---- your day, counted per trade (not per fill row) -------------------------------------------------------- */

const H = ['TradeGroupId', 'Date (IST)', 'Symbol', 'Direction', 'OrderType', 'Price', 'Qty', 'NetPnL', 'TotalCharges', 'Time (IST)', 'ExitType', 'DirFromFills', 'Setup'];
const rows = [
  ['G1', '2026-10-12', 'TATASTEEL', 'LONG', 'BUY', '300', '100', '-250', '40', '09:24:00', 'STOP', 'LONG', 'momentum'],
  ['G1', '2026-10-12', 'TATASTEEL', 'LONG', 'SELL', '297.5', '100', '-250', '40', '09:31:00', 'STOP', 'LONG', 'momentum'],
  ['G2', '2026-10-12', 'SAIL', 'LONG', 'SELL', '120', '200', '180', '30', '10:02:00', 'TARGET', 'SHORT', 'reversal'],
  ['G2', '2026-10-12', 'SAIL', 'LONG', 'BUY', '119', '200', '180', '30', '10:20:00', 'TARGET', 'SHORT', 'reversal'],
].map((cells) => ({ cells }));

test('behaviour counts each trade once and takes direction from the fills', () => {
  const t = summarizeTrades(H, rows);
  assert.equal(t.length, 2);
  assert.equal(t[1].direction, 'SHORT'); // Direction column said LONG
  const b = computeBehaviour(t, { today: '2026-10-12', nowMs: IST('2026-10-12', '10:30:00'), symbol: 'TATASTEEL', direction: 'LONG', setup: 'MOMENTUM', openPositions: 0 });
  assert.equal(b.TradesToday, 2);
  assert.equal(b.PnlToday, -70); // not -320 or -140: fill rows are not added up
  assert.equal(b.FirstTradeLost, true);
  assert.equal(b.SameSymbolStopped, true);
  assert.equal(b.MinSinceLoss, 59);
  assert.equal(chargeRate(t), undefined); // needs at least 3 trades
  const three = summarizeTrades(H, [...rows, ...rows.slice(0, 2).map((r) => ({ cells: r.cells.map((c, i) => (i === 0 ? 'G3' : c)) }))]);
  assert.ok(Math.abs(chargeRate(three)! - 110 / (59750 * 2 + 47800)) < 1e-9);
});

/* ---- linking checks to the logged trade --------------------------------------------------------------------- */

test('linking: latest entry check within 10 minutes, same direction, re-checks while open', () => {
  const ck = (id: string, time: string, extra: Record<string, string> = {}) => ({ rowNumber: 2, o: { CheckId: id, Date: '2026-10-12', Time: time, Symbol: 'TATASTEEL', Direction: 'LONG', Mode: 'ENTRY', Verdict: 'MIXED', Line1: 'a', Line2: 'b', ...extra } });
  const r = [
    ck('old', '09:05:00'), ck('first', '09:20:00'), ck('latest', '09:23:30', { Verdict: 'WARNING' }),
    ck('short', '09:23:50', { Direction: 'SHORT' }),
    ck('re1', '09:28:00', { Mode: 'MANAGE', Verdict: 'WEAKENING', CostInr: '1.1' }),
    ck('after', '09:50:00', { Mode: 'MANAGE' }),
  ];
  const { entry, manage } = matchChecks(r, { date: '2026-10-12', symbol: 'TATASTEEL', direction: 'LONG', entryTs: IST('2026-10-12', '09:24:00'), lastTs: IST('2026-10-12', '09:31:00') });
  assert.equal(entry?.o.CheckId, 'latest');
  assert.deepEqual(manage.map((m) => m.o.CheckId), ['re1']);
  const cols = monthlyColumns(entry, manage);
  assert.equal(cols.CkId, 'latest');
  assert.equal(cols.CkVerdict, 'WARNING');
  assert.equal(cols.CkLines, 'a | b');
  assert.equal(cols.RcCount, 1);
  assert.equal(cols.RcLastLabel, 'WEAKENING');
});

/* ---- prompt and Claude ------------------------------------------------------------------------------------- */

test('the message stays small and never carries a token', () => {
  const inp = base();
  const facts = computeFacts(inp);
  const msg = buildMessage({
    mode: 'ENTRY', time: '09:30', direction: 'LONG', setup: 'MOMENTUM', symbol: 'TATASTEEL', riskInr: 300, price: 304.6,
    facts, behaviour: computeBehaviour([], { today: inp.date, nowMs: inp.nowMs, symbol: 'X', direction: 'LONG', setup: 'MOMENTUM', openPositions: 0 }),
    todayTrades: [], stock1m: inp.stock1m, nifty1m: inp.nifty1m, date: inp.date, asOfMs: inp.nowMs,
  });
  assert.ok(msg.length < 9000, `message ${msg.length} chars`);
  assert.doesNotMatch(msg, /eyJ|access-token|client/i);
  assert.match(msg, /^Mode ENTRY/);
  assert.ok(SYSTEM_PROMPT.includes('HOLD_STEADY') && SYSTEM_PROMPT.includes('Never tell him to buy'));
});

test('Claude: sends a structured-output schema (no tools), reads the JSON, retries once when overloaded, explains a bad key', async () => {
  let calls = 0; let sent: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const good = { content: [{ type: 'text', text: JSON.stringify({ verdict: 'WARNING', lines: ['one', 'two', 'three', 'four'], watch: 'w' }) }], stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 200, cache_read_input_tokens: 2500 } };
  const f = (async (_u: unknown, init: { body: string }) => {
    calls++; sent = JSON.parse(init.body);
    return calls === 1 ? new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), { status: 529 }) : new Response(JSON.stringify(good), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await askClaude('msg', { apiKey: 'k', fetchImpl: f, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(sent.tools, undefined); assert.equal(sent.tool_choice, undefined);
  assert.equal(sent.output_config.format.type, 'json_schema');
  const schema = sent.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(schema), /maxItems|minLength|maximum/); // unsupported keywords would be a 400
  assert.equal(r.verdict, 'WARNING');
  assert.equal(r.lines.length, 3);
  assert.equal(r.inTokens, 6500);
  assert.equal(r.costInr, costInr('claude-sonnet-5-5', good.usage, 88));
  const bad = (async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'x' } }), { status: 401 })) as typeof fetch;
  await assert.rejects(askClaude('m', { apiKey: 'k', fetchImpl: bad }), /ANTHROPIC_API_KEY/);
});

test('Claude: an answer that does not parse is shown as text, never thrown away', async () => {
  const f = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Volume is fading into the high.' }], stop_reason: 'end_turn', usage: {} }), { status: 200 })) as typeof fetch;
  const r = await askClaude('m', { apiKey: 'k', fetchImpl: f });
  assert.equal(r.verdict, 'RAW'); assert.deepEqual(r.lines, ['Volume is fading into the high.']);
  const cutoff = (async () => new Response(JSON.stringify({ content: [], stop_reason: 'max_tokens', usage: {} }), { status: 200 })) as typeof fetch;
  const c = await askClaude('m', { apiKey: 'k', fetchImpl: cutoff });
  assert.equal(c.verdict, 'RAW'); assert.match(c.lines[0], /cut off/);
  const lower = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"hold steady","lines":["a"],"watch":"b"}' }], usage: {} }), { status: 200 })) as typeof fetch;
  assert.equal((await askClaude('m', { apiKey: 'k', fetchImpl: lower })).verdict, 'HOLD_STEADY');
});

test('a steady trend is not counted as many pullbacks, and the breakout high is not an obstacle', () => {
  const f = computeFacts(base({ plannedStop: 303.9 }));
  assert.ok(f.PullbackNo! <= 1, `pullbacks ${f.PullbackNo}`);
  assert.ok(f.RoomAtr === undefined || f.RoomAtr > 0.5, `room ${f.RoomAtr}`);
});

/* ---- what happened next -------------------------------------------------------------------------------------- */
import { outcomeOf, planOutcomes, runOutcomes } from '../lib/copilot/outcomes';
import { FakeSheets } from './helpers';

test('outcome: best and worst move in R over the next 30 minutes, and whether the stop was hit', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: IST('2026-10-12', '09:25:00') / 1000 + i * 60, o: 300, h: 300 + (i === 5 ? 3 : 0.2), l: 300 - (i === 35 ? 5 : 0.4), c: 300, v: 1 }));
  const o = outcomeOf(bars, { ts: IST('2026-10-12', '09:24:30'), price: 300, direction: 'LONG', dist: 1 })!;
  assert.equal(o.mfeR, 3); assert.equal(o.maeR, 0.4); assert.equal(o.hitStop, false); // the 5-point drop is after 30 minutes
  const s = outcomeOf(bars, { ts: IST('2026-10-12', '09:24:30'), price: 300, direction: 'SHORT', dist: 1 })!;
  assert.equal(s.maeR, 3); assert.equal(s.hitStop, true);
});

test('outcomes are planned only for checks older than 30 minutes and written into the checks tab', async () => {
  const f = new FakeSheets();
  f.addTab('october-2026-checks', [
    ['CheckId', 'Date', 'Time', 'SecurityId', 'Direction', 'Ltp', 'PlannedStop', 'Atr2', 'AfterMfeR30', 'AfterMaeR30', 'AfterHitStop'],
    ['A', '2026-10-12', '09:24:30', '11', 'LONG', '300', '299', '2', '', '', ''],
    ['B', '2026-10-12', '10:00:00', '11', 'LONG', '300', '', '2', '', '', ''],
  ]);
  const items = await planOutcomes(f.client(), IST('2026-10-12', '10:10:00'));
  assert.deepEqual(items.map((i) => i.checkId), ['A']);
  const dhan = { intraday: async () => trend };
  const r = await runOutcomes({ dhan, sheets: f.client(), sleep: async () => {} }, items);
  assert.equal(r.done, 1);
  const row = f.table('october-2026-checks')[0];
  assert.notEqual(row.AfterMfeR30, ''); assert.equal(row.AfterHitStop, 'NO');
});


/* ---- risk setting stored in the sheet ----------------------------------------------------------------------- */
import { getRiskInr, setRiskInr } from '../lib/copilot/userSettings';

test('risk per trade: 300 by default, changed from the app and read back from the sheet', async () => {
  const f = new FakeSheets();
  assert.equal(await getRiskInr(f.client(), 1), 300);
  assert.equal(await setRiskInr(f.client(), 400, 2), 400);
  assert.deepEqual(f.table('copilot-settings').map((r) => [r.Key, r.Value]), [['RiskInr', '400']]);
  await setRiskInr(f.client(), 350, 3);
  assert.equal(f.table('copilot-settings').length, 1); // updated in place, not appended
  assert.equal(await getRiskInr(f.client(), 70_000), 350); // after the 60 s cache, read from the sheet
  await assert.rejects(setRiskInr(f.client(), -5), /positive/);
});

/* ---- cut-off replies and thinking --------------------------------------------------------------------------- */
import { salvageRead } from '../lib/copilot/claude';

test('a reply cut off mid-JSON still shows its complete lines, not raw JSON', async () => {
  const cut = '{"verdict":"WARNING","lines":["Re-entry: AEQUS short already stopped you out today for -157.","Room to PDL is 0.18 ATR against a 2.84 stop: RoomVsStop 0.09.","Nifty state unknown and';
  const s = salvageRead(cut);
  assert.equal(s.verdict, 'WARNING');
  assert.deepEqual(s.lines, ['Re-entry: AEQUS short already stopped you out today for -157.', 'Room to PDL is 0.18 ATR against a 2.84 stop: RoomVsStop 0.09.']);
  const f = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: cut }], stop_reason: 'max_tokens', usage: {} }), { status: 200 })) as typeof fetch;
  const r = await askClaude('m', { apiKey: 'k', fetchImpl: f });
  assert.equal(r.verdict, 'WARNING');
  assert.equal(r.lines.length, 2);
  assert.match(r.watch, /cut short/);
});

test('up-front thinking is off by default (between_tools) and on only when asked', async () => {
  const bodies: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = (async (_u: unknown, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"MIXED","lines":["a"],"watch":"b"}' }], usage: {} }), { status: 200 }); }) as unknown as typeof fetch;
  await askClaude('m', { apiKey: 'k', fetchImpl: f });
  await askClaude('m', { apiKey: 'k', fetchImpl: f, thinking: 'on' });
  assert.deepEqual(bodies[0].thinking, { type: 'between_tools' }); assert.equal(bodies[0].max_tokens, 1000);
  assert.equal(bodies[1].thinking, undefined); assert.equal(bodies[1].max_tokens, 4000);
  assert.equal(bodies[0].output_config.format.type, 'json_schema');
});

test('a check reads Nifty 500 from a week of candles (the request that fixes "Nifty state unknown")', () => {
  const week = merge(
    day('2026-10-08', () => ({ o: 24000, h: 24010, l: 23990, c: 24000 })),
    day('2026-10-09', () => ({ o: 24000, h: 24010, l: 23990, c: 24000 })),
    niftyUp,
  );
  const f = computeFacts(base({ nifty1m: week, nowMs: IST('2026-10-12', '09:45:20') })); // 15m strength needs 15+ minutes
  assert.notEqual(f.NiftyState, 'UNKNOWN');
  assert.ok(f.NiftyFirst5Pct !== undefined && f.NiftyNowPct !== undefined && f.RsVsNiftyPct !== undefined && f.Rs20mPct !== undefined);
  // and an empty answer from Dhan is what produced UNKNOWN before
  assert.equal(computeFacts(base({ nifty1m: { t: [], o: [], h: [], l: [], c: [], v: [] } })).NiftyState, 'UNKNOWN');
});

test('AEQUS case: a momentum short at 264 names a real level as the obstacle, never the first 5-min candle low', () => {
  // first 5 minutes: 263.75-269.35; later breaks to 262.3 (09:45) and comes back to 264
  const d = day('2026-10-14', (m) => {
    if (m < 5) return { o: 268, h: m === 1 ? 269.35 : 268.5, l: m === 3 ? 263.75 : 266, c: 267 };
    if (m < 30) return { o: 266 - (m - 5) * 0.1, h: 266.2 - (m - 5) * 0.1, l: 265.8 - (m - 5) * 0.1, c: 266 - (m - 5) * 0.1 };
    if (m === 30) return { o: 262.6, h: 262.8, l: 262.3, c: 262.5 };
    return { o: 263.9, h: 264.2, l: 263.8, c: 264 };
  }, 60);
  const daily = dailyFlat(800, 275); daily.l[daily.l.length - 1] = 262.7; // previous day low 262.70
  const f = computeFacts(base({ date: '2026-10-14', nowMs: IST('2026-10-14', '10:14:30'), price: 264, direction: 'SHORT', setup: 'MOMENTUM', stock1m: merge(...calm, d), nifty1m: { t: [], o: [], h: [], l: [], c: [], v: [] }, daily }));
  assert.equal(f.OrLow, 263.75);
  assert.equal(f.EntryVsOr, 'INSIDE');
  assert.equal(f.DayLow, 262.3);
  assert.equal(f.RoomTo, 'prev day low 262.7'); // the nearest REAL level below, not 263.75
  assert.ok(Math.abs(f.RoomAtr! * f.Atr10m! - 1.3) < 0.02, `room ${f.RoomAtr} ATR`); // 264 - 262.70
});

test('10-minute chart basis: first 10-min candle from 09:25, pullbacks/climax on 10-min candles, message carries 10M candles', () => {
  assert.equal(computeFacts(base({ nowMs: IST('2026-10-12', '09:24:30') })).OrHigh, undefined); // still forming
  const f = computeFacts(base({ nowMs: IST('2026-10-12', '09:40:20') }));
  assert.ok(f.OrHigh !== undefined);
  assert.equal(f.OrHigh, 303.2); // highest high of 09:15-09:24 in the trend fixture (300.5 + 9*0.3)
  const msg = buildMessage({
    mode: 'ENTRY', time: '09:40', direction: 'LONG', setup: 'MOMENTUM', symbol: 'X', riskInr: 300, price: 304.6, facts: f,
    behaviour: computeBehaviour([], { today: '2026-10-12', nowMs: 0, symbol: 'X', direction: 'LONG', setup: 'MOMENTUM', openPositions: 0 }),
    todayTrades: [], stock1m: base().stock1m, nifty1m: niftyUp, date: '2026-10-12', asOfMs: IST('2026-10-12', '09:40:20'),
  });
  assert.match(msg, /STOCK_10M since open/);
  assert.doesNotMatch(msg, /STOCK_1M|STOCK_5M/);
  assert.match(msg, /09:35,.*,forming/); // the 09:35 candle is still forming at 09:40
  assert.doesNotMatch(msg, /09:25,.*forming/);
});

/* ---- the whole check, end to end, with a stand-in for Dhan ------------------------------------------------- */
import { buildCheck } from '../lib/copilot/service';

function fakeDhan(opts: { niftyEmpty?: boolean } = {}) {
  const wk = (from: string, to: string) => { const o: string[] = []; for (let ms = Date.parse(from + 'T00:00:00Z'); ms <= Date.parse(to + 'T00:00:00Z'); ms += 864e5) { const d = new Date(ms); if (d.getUTCDay() % 6) o.push(d.toISOString().slice(0, 10)); } return o; };
  const calls: string[] = [];
  return {
    calls,
    async intraday(p: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push(`I ${p.securityId} ${p.from}..${p.to}`);
      const c: Candles = { t: [], o: [], h: [], l: [], c: [], v: [] };
      if (p.securityId === '19' && opts.niftyEmpty) return c;
      for (const d of wk(p.from, p.to)) {
        if (d > '2026-10-14') continue; // no session yet on the 15th
        for (let m = 0; m < 375; m++) { const px = (p.securityId === '19' ? 24000 : 264) + Math.sin(m / 9); c.t.push(IST(d, '09:15:00') / 1000 + m * 60); c.o.push(px); c.h.push(px + 0.3); c.l.push(px - 0.3); c.c.push(px); c.v.push(1000); }
      }
      return c;
    },
    async daily() { return dailyFlat(900, 270); },
    async ltp() { return undefined; }, async positions() { return []; }, async trades() { return []; }, async orders() { return []; },
  };
}

test('end to end after hours: reads the last session, Nifty from the same request as the market strip', async () => {
  const d = fakeDhan();
  const r = await buildCheck({ dhan: d, sheets: new FakeSheets().client(), lookupSecurityId: async () => '11', now: () => IST('2026-10-15', '01:58:00') }, { direction: 'SHORT', setup: 'MOMENTUM', symbol: 'AEQUS' });
  assert.equal(r.date, '2026-10-14');
  assert.notEqual(r.facts.NiftyState, 'UNKNOWN');
  assert.ok(r.facts.NiftyFirst5Pct !== undefined && r.facts.RsVsNiftyPct !== undefined);
  assert.ok(d.calls.some((c) => c.startsWith('I 19 ') && c.endsWith('..2026-10-15')), d.calls.join(' | ')); // up to today, like the strip
});

test('end to end: when Dhan sends no Nifty candles, the card says exactly what came back', async () => {
  // a different day, so the 30 s Nifty cache from the test above is not reused
  const r = await buildCheck({ dhan: fakeDhan({ niftyEmpty: true }), sheets: new FakeSheets().client(), lookupSecurityId: async () => '11', now: () => IST('2026-10-16', '01:58:00') }, { direction: 'SHORT', setup: 'MOMENTUM', symbol: 'AEQUS' });
  assert.equal(r.facts.NiftyState, 'UNKNOWN');
  assert.ok(r.notes.some((n) => /Nifty 500 for 2026-10-14: Dhan returned 0 candles/.test(n)), r.notes.join(' | '));
});
