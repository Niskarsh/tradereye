import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adviceHits, applyPatch, checkDraft, cleanDraft, cleanMediumUrl, cleanSettings, cleanTags, defaultSettings, secretHits,
  suggestPublications, tickerHits, toMediumHtml, unknownNumbers, withDisclaimer, yourWordsShare, DISCLAIMER_MARK,
  OLD_PRICES_LINE, type Article, type Material,
} from '../lib/medium/article';
import { buildingMaterial, factsFor, labeller, strategyLetter, tradeChart, tradesMaterial, vsMaterial } from '../lib/medium/material';
import type { ShortTrade } from '../lib/shorts/trades';
import type { LedgerEntry } from '../lib/ml/ledger';

const NOW = Date.parse('2026-10-25T10:00:00Z');

function trade(id: string, date: string, symbol: string, net: number, risk?: number, extra: Partial<ShortTrade> = {}): ShortTrade {
  return {
    id, date, symbol, dir: 'LONG', entryTime: '09:40:00', exitTime: '10:10:00', avgEntry: 100, avgExit: 101,
    fills: [{ time: '09:40:00', price: 100, qty: 10, kind: 'in' }, { time: '10:10:00', price: 101, qty: 10, kind: 'out' }],
    net, risk, netR: risk ? Math.round((net / risk) * 100) / 100 : undefined, movePct: 1, holdMin: 30, exitType: 'TARGET',
    context: { Setup: 'SECRET-SETUP', RvolAtEntry: '3.1' }, ...extra,
  };
}

/* ---------------- edge and SEBI guards ---------------- */

test('secret terms are found whole-word, case-insensitive, and block copying', () => {
  assert.deepEqual(secretHits('I used the Gap Fade filter at 2.5 ATR', ['gap fade', '2.5 ATR', 'fade']), ['gap fade', '2.5 ATR', 'fade']);
  assert.deepEqual(secretHits('faded', ['fade']), []);
  const a = { draft: 'My gap fade worked.', answers: [], kit: undefined, material: { hiddenTickers: [], images: [], facts: [] } as unknown as Material };
  assert.equal(checkDraft(a, ['gap fade']).blocked, true);
});

test('recent tickers in the text block copying (SEBI 3-month rule)', () => {
  assert.deepEqual(tickerHits('I shorted RELIANCE at the open', ['RELIANCE', 'TCS']), ['RELIANCE']);
  assert.deepEqual(tickerHits('Stock A dropped', ['RELIANCE']), []);
});

test('advice phrases are flagged, his own past trades are not', () => {
  assert.equal(adviceHits('I shorted it at 09:40 and got stopped.').length, 0);
  assert.ok(adviceHits('You should buy this stock now').length >= 1);
  assert.ok(adviceHits('This is a sure-shot multibagger').length >= 1);
  assert.ok(adviceHits('Price target 1200').length >= 1);
});

test('numbers not in the data or his answers are flagged; rounding is allowed', () => {
  const src = ['net +14.37R over 9 trades, ₹1,250 after charges'];
  assert.deepEqual(unknownNumbers('I made 14.4R, about 14R, in 9 trades and ₹1,250.', src), []);
  assert.deepEqual(unknownNumbers('I made 22R in 9 trades.', src), ['22']);
  assert.deepEqual(unknownNumbers('[IMAGE equity] on 2026-10-21', src), []);
});

test('your-words share: his sentences rearranged score high, rewording scores low', () => {
  const answers = ['I kept moving my stop because I hated being wrong on that trade', 'the model failed the exam months and that hurt more than any loss'];
  const mine = '## The stop\nI kept moving my stop because I hated being wrong on that trade.\n\nThe model failed the exam months and that hurt more than any loss.';
  const ai = '## The stop\nAdjusting protective orders repeatedly reflected an aversion to admitting error, a common pitfall for traders everywhere.';
  assert.ok(yourWordsShare(mine, answers) > 0.95);
  assert.ok(yourWordsShare(ai, answers) < 0.1);
  // the disclaimer and headings do not count against him
  assert.ok(yourWordsShare(withDisclaimer(mine, false), answers) > 0.95);
});

/* ---------------- disclaimer, HTML, kit ---------------- */

test('the disclaimer is added once, survives re-saves, and adds the old-prices line when asked', () => {
  const once = withDisclaimer('Hello world', true);
  assert.equal(once.split(DISCLAIMER_MARK).length, 2);
  assert.ok(once.includes(OLD_PRICES_LINE));
  const twice = withDisclaimer(once, false);
  assert.equal(twice.split(DISCLAIMER_MARK).length, 2);
  assert.ok(!twice.includes(OLD_PRICES_LINE));
});

test('Medium HTML: headings, lists, bold, image lines; no raw HTML from the draft', () => {
  const h = toMediumHtml('## Section\nHi **there** <script>\n- one\n- two\n[IMAGE equity]\n---', [{ id: 'equity', title: 'The week', caption: 'Real data.', data: { kind: 'equity', unit: 'R', points: [] } }]);
  assert.match(h, /<h3>Section<\/h3>/);
  assert.match(h, /<strong>there<\/strong> &lt;script&gt;/);
  assert.match(h, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(h, /\[Image: The week\]/);
  assert.match(h, /<hr>/);
});

test('tags: 5 at most, Medium-valid', () => {
  assert.deepEqual(cleanTags(['#Algorithmic Trading', 'day trading', 'Day Trading', 'ML!', 'stock-market', 'python', 'extra']), ['algorithmic trading', 'day trading', 'ml', 'stock-market', 'python']);
});

test('cleanDraft drops image markers that do not exist', () => {
  assert.equal(cleanDraft('a\n[IMAGE nope]\n[IMAGE best]\nb', [{ id: 'best', title: '', caption: '', data: { kind: 'banner' } }]), 'a\n[IMAGE best]\nb');
});

test('published link: https only (publications on their own domain allowed)', () => {
  assert.equal(cleanMediumUrl('https://medium.com/ai-advances/my-story-abc123?source=x'), 'https://medium.com/ai-advances/my-story-abc123');
  assert.equal(cleanMediumUrl('https://ai.gopubby.com/my-story-abc123'), 'https://ai.gopubby.com/my-story-abc123');
  assert.equal(cleanMediumUrl('http://medium.com/x'), null);
  assert.equal(cleanMediumUrl('javascript:alert(1)'), null);
});

/* ---------------- publications ---------------- */

test('Lampshade (AI-only publication) is never suggested and cannot be chosen', () => {
  const s = defaultSettings();
  for (const f of ['weekly', 'vs-algo', 'building', 'monthly'] as const) assert.ok(!suggestPublications(f, s.publications).some((p) => p.never));
  assert.equal(suggestPublications('building', s.publications)[0].name, 'AI Advances');
  const a = { v: 1, id: 'm-20261025-000000000000', format: 'building', createdAt: 0, updatedAt: 0, material: buildingMaterial({ from: '5', to: '5', label: 'x' }, []), shared: [], questions: [], answers: [], draft: '', costInr: 0 } as Article;
  assert.ok(applyPatch(a, { kit: { publication: 'Lampshade of ILLUMINATION' } }, s.publications).error);
  assert.equal(applyPatch(a, { kit: { publication: 'AI Advances' } }, s.publications).article.kit?.publication, 'AI Advances');
});

test('settings are cleaned: bad urls dropped, terms trimmed and de-duplicated', () => {
  const s = cleanSettings({ publications: [{ name: 'X', url: 'https://evil.com', fits: ['building', 'nope'] }], secretTerms: [' gap fade ', 'gap fade', 'x', ''] });
  assert.equal(s.publications[0].url, '');
  assert.deepEqual(s.publications[0].fits, ['building']);
  assert.deepEqual(s.secretTerms, ['gap fade']);
});

/* ---------------- material: what Claude may see ---------------- */

test('recent trades are labelled Stock A / B; trades over 92 days keep their ticker', () => {
  const ts = [trade('1', '2026-10-20', 'RELIANCE', 100, 100), trade('2', '2026-10-21', 'TCS', -50, 100), trade('3', '2026-10-22', 'RELIANCE', 20, 100), trade('4', '2026-06-01', 'INFY', 10, 100)];
  const l = labeller(ts, NOW);
  assert.deepEqual(ts.map(l.label), ['Stock A', 'Stock B', 'Stock A', 'INFY']);
  assert.deepEqual(l.hidden.sort(), ['RELIANCE', 'TCS']);
});

test('weekly material: no ticker of a recent trade and no journal context columns reach the facts', () => {
  const ts = [trade('1', '2026-10-20', 'RELIANCE', 300, 100, { comment: 'held through the pullback' }), trade('2', '2026-10-21', 'TCS', -100, 100)];
  const m = tradesMaterial('weekly', { from: '2026-10-19', to: '2026-10-23', label: 'w' }, ts, undefined, new Map(), NOW);
  const all = m.facts.join('\n');
  assert.ok(!/RELIANCE|TCS/.test(all));
  assert.ok(!/SECRET-SETUP|RvolAtEntry|3\.1/.test(all));
  assert.match(all, /held through the pullback/);
  assert.match(all, /2 trades, 1 wins, 1 losses \(hit rate 50%\), net \+2\.0R/);
  assert.deepEqual(m.hiddenTickers.sort(), ['RELIANCE', 'TCS']);
  assert.equal(m.oldPrices, false);
  assert.ok(m.images.some((i) => i.id === 'equity' && i.data.kind === 'equity' && i.data.unit === 'R'));
});

test('Me vs Algo material uses the frozen score it is given', () => {
  const me = [trade('1', '2026-10-20', 'RELIANCE', 100, 100)], algo = [trade('2', '2026-10-23', 'TCS', -100, 100, { dir: 'SHORT' })];
  const week = { week: '2026-10-19', me: { r: 9, n: 1, uncounted: 0 }, algo: { r: -1, n: 1, uncounted: 0 }, winner: 'me' as const };
  const m = vsMaterial({ from: '2026-10-19', to: '2026-10-23', label: 'w' }, week, { me: 1, algo: 0 }, [week], me, algo, new Map(), NOW);
  assert.match(m.facts[0], /him \+9\.0R from 1 trades, the algo −1\.0R/);
  assert.ok(m.images.some((i) => i.data.kind === 'scoreboard'));
});

test('Algo Lab material: strategy names and what-changed lines stay out until he ticks them', () => {
  const e: LedgerEntry = {
    iteration: 7, runId: 'r7', createdAt: Date.parse('2026-08-12T00:00:00Z'), code: 'abc', best: 'tight',
    changes: ['added the SECRET-FEATURE input', 'more months of data'],
    lines: [{ id: 'tight', name: 'Tight bracket (1 ATR stop, 1.5 ATR target)', n: 400, netR: 0.052, gross: null, t: 2.1, monthsGreen: 9, monthsTraded: 14, dev: 0.04, exam: -0.031, ic: null }],
  };
  const m = buildingMaterial({ from: '7', to: '7', label: 'Iterations 7–7' }, [e]);
  const facts = m.facts.join('\n');
  assert.ok(!/Tight bracket|ATR stop|SECRET-FEATURE|more months/.test(facts));
  assert.match(facts, /Strategy A 400 trades, \+0\.05R a trade overall, t 2\.1, 9\/14 months green, decide months \+0\.04R a trade, exam months −0\.03R a trade \(FAILED the exam\)/);
  assert.match(facts, /This is part 7 of the series/);
  assert.equal(m.changes?.length, 2);
  const shared = factsFor(m, [1]).join('\n');
  assert.match(shared, /more months of data/);
  assert.ok(!/SECRET-FEATURE/.test(shared));
  assert.deepEqual(m.images.find((i) => i.data.kind === 'iterations')?.data, { kind: 'iterations', bars: [{ label: '#7', value: -0.03, note: 'exam' }] });
});

test('strategy letters: keep a letter id, map descriptive ids by order', () => {
  assert.equal(strategyLetter('F', []), 'F');
  assert.equal(strategyLetter('tight', ['wide', 'tight']), 'Strategy B');
});

test('trade chart: 1-minute candles become 5-minute ones from 09:15 to 30 min after the exit, with his marks', () => {
  const base = Date.parse('2026-06-01T09:15:00Z') / 1000 - 19800;
  const minute = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[] };
  for (let i = 0; i < 120; i++) { minute.t.push(base + i * 60); minute.o.push(100 + i * 0.01); minute.h.push(100.5 + i * 0.01); minute.l.push(99.5 + i * 0.01); minute.c.push(100.1 + i * 0.01); }
  const c = tradeChart(trade('4', '2026-06-01', 'INFY', 10, 100, { stop: 99 }), minute, 'INFY')!;
  assert.equal(c.candles.length, Math.ceil((55 + 30 + 1) / 5)); // 09:15 -> 10:40
  assert.equal(c.candles[0].h, Math.max(...minute.h.slice(0, 5)));
  assert.deepEqual(c.marks.map((m) => m.role), ['ENTRY', 'EXIT']);
  assert.equal(c.stop, 99);
});

test('a ticker that is also a word only blocks in capitals', () => {
  assert.deepEqual(tickerHits('that was a good idea', ['IDEA']), []);
  assert.deepEqual(tickerHits('I sold IDEA early', ['IDEA']), ['IDEA']);
  assert.deepEqual(tickerHits('#idea', ['IDEA']), ['IDEA']);
});

test('iterations 1-4 come from the notes; a later part gets a one-line recap of each earlier one', async () => {
  const { EARLY_NOTES } = await import('../lib/medium/early');
  const { recapOf } = await import('../lib/medium/material');
  assert.deepEqual(EARLY_NOTES.map((n) => n.iteration), [1, 2, 3, 4]);
  const first = buildingMaterial({ from: '1', to: '1', label: 'Iteration 1' }, [], [EARLY_NOTES[0]]);
  assert.match(first.facts.join('\n'), /This is part 1 of the series .* It is the first part\./);
  assert.match(first.facts.join('\n'), /701 trades, −0\.20R a trade/);
  // the notes' what-changed lines are offered unticked, never in the facts
  assert.equal(first.changes?.length, EARLY_NOTES[0].changes.length);
  assert.ok(!first.facts.join('\n').includes('calendar in disguise'));
  const third = buildingMaterial({ from: '3', to: '3', label: 'Iteration 3' }, [], [EARLY_NOTES[2]], EARLY_NOTES.slice(0, 2).map(recapOf));
  const f = third.facts.join('\n');
  assert.match(f, /Earlier parts covered iterations 1–2/);
  assert.match(f, /Before this \(iteration 1, recap only\)/);
  const bars = third.images.find((i) => i.data.kind === 'iterations')!.data as { bars: { label: string }[] };
  assert.deepEqual(bars.bars.map((b) => b.label), ['#1', '#2', '#3']);
  // no input names, thresholds or rules in the notes the article can draw on
  for (const n of EARLY_NOTES) assert.ok(!/ATR|Nifty|VWAP|RVOL|½|¾/i.test([n.facts, ...n.changes].join(' ')), `iteration ${n.iteration}`);
});

test('series links: published earlier parts, oldest first', async () => {
  const { seriesLinks } = await import('../lib/medium/article');
  const h = (id: string, it: number, url?: string) => ({ id, format: 'building' as const, period: '', title: `T${it}`, createdAt: 0, updatedAt: 0, iterations: [it, it] as [number, number], ...(url ? { published: { url, at: 0 } } : {}) });
  const heads = [h('c', 3, 'https://medium.com/x/3'), h('a', 1, 'https://medium.com/x/1'), h('b', 2), h('d', 5, 'https://medium.com/x/5')];
  const m = buildingMaterial({ from: '4', to: '4', label: 'Iteration 4' }, []);
  assert.deepEqual(seriesLinks({ format: 'building', material: m }, heads).map((x) => x.label), ['Part 1', 'Part 3']);
});
