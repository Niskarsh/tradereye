import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adviceHits, applyPatch, checkDraft, cleanDraft, cleanMediumUrl, cleanSettings, cleanTags, defaultSettings, secretHits,
  suggestPublications, tickerHits, toMediumHtml, unknownNumbers, withDisclaimer, yourWordsShare, DISCLAIMER_MARK,
  OLD_PRICES_LINE, type Article, type Material,
} from '../lib/medium/article';
import { buildingMaterial, factsFor, labeller, versionName, tradeChart, tradesMaterial, vsMaterial } from '../lib/medium/material';
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
  assert.match(m.facts.join('\n'), /him \+9\.0R from 1 trades, the algo −1\.0R/);
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
  assert.match(facts, /The model: 400 test trades, \+0\.05R a trade \(on average each trade made 5% of the amount it risked\); made money in 9 of the 14 months it traded; confidence score t 2\.1; decide months \+0\.04R a trade; exam months −0\.03R a trade \(FAILED the exam/);
  assert.ok(!/Strategy [A-Z]/.test(facts));
  assert.match(facts, /Plain-words glossary/);
  assert.match(facts, /This is part 7 of the series/);
  assert.equal(m.changes?.length, 2);
  const shared = factsFor(m, [1]).join('\n');
  assert.match(shared, /more months of data/);
  assert.ok(!/SECRET-FEATURE/.test(shared));
  assert.deepEqual(m.images.find((i) => i.data.kind === 'iterations')?.data, { kind: 'iterations', bars: [{ label: '#7', value: -0.03, note: 'exam' }] });
});

test('versions get plain names, never letters', () => {
  assert.equal(versionName('F', 'F', ['F']), 'the model');
  assert.equal(versionName('F', 'F', ['B', 'F', 'G']), 'the version it kept');
  assert.equal(versionName('G', 'F', ['B', 'F', 'G']), 'comparison version 2');
});

test('questions that ask him for data are recognised', async () => {
  const { asksForFact } = await import('../lib/medium/article');
  assert.ok(asksForFact('Which month was the green one?'));
  assert.ok(asksForFact('Strategy A lost 701 trades. Why?'));
  assert.ok(asksForFact('How many trades did you take?'));
  assert.ok(!asksForFact('Your first version lost money in 8 of 9 months. What did you think when you saw that?'));
});

test('jargon a beginner would not know is flagged unless explained in the same sentence', async () => {
  const { jargonHits } = await import('../lib/medium/article');
  assert.ok(jargonHits('Strategy A made +0.05R.').length >= 2);
  assert.deepEqual(jargonHits('Each trade made +0.05R, where R means the amount I risked on it.'), []);
  assert.ok(jargonHits('The t-stat was 2.1.').some((x) => x.startsWith('t ')));
  assert.deepEqual(jargonHits('The confidence score (t) was 2.1, which means it is probably not luck.'), []);
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
  assert.match(first.facts.join('\n'), /701 test trades; −0\.20R a trade/);
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

/* ---------------- Gemini image prompts ---------------- */

test('every section gets an image line right under its heading; old section markers are replaced', async () => {
  const { placeSectionMarkers, sectionsOf, sectionsWithoutImage } = await import('../lib/medium/prompts');
  const d = placeSectionMarkers('Intro line.\n\n## First try\nText.\n[IMAGE s9]\n## The exam\nMore.\n[IMAGE best]');
  assert.equal(d, 'Intro line.\n\n## First try\n\n[IMAGE s1]\nText.\n## The exam\n\n[IMAGE s2]\nMore.\n[IMAGE best]');
  assert.deepEqual(sectionsOf(d), ['First try', 'The exam']);
  const ai = [{ id: 's1', section: 'First try', hook: '', scene: 'x', caption: '' }];
  assert.deepEqual(sectionsWithoutImage(d, ai), ['The exam']);
  assert.deepEqual(sectionsWithoutImage(`${d}\n## Added later\nNew text.`, ai), ['The exam', 'Added later']);
});

test('prompts: hook max 6 words and the only text, style and rules always added, captions labelled as AI once', async () => {
  const { buildPrompt, aiCaption, toAiImages, cleanAiImages, DEFAULT_STYLE, AI_LABEL } = await import('../lib/medium/prompts');
  const p = buildPrompt({ hook: '"8 months. 8 losses. One stubborn developer."', scene: 'A laptop at dawn, the hook on its screen.' });
  assert.match(p, /ONLY readable text in the image is "8 months\. 8 losses\. One stubborn"/);
  assert.ok(p.includes(DEFAULT_STYLE));
  assert.match(p, /Avoid: logos, brand names/);
  assert.match(buildPrompt({ hook: '', scene: 'x' }), /no readable text anywhere/);
  assert.equal(aiCaption('Hold my prompt.'), `Hold my prompt. ${AI_LABEL}`);
  assert.equal(aiCaption(`Hold my prompt. ${AI_LABEL}`), `Hold my prompt. ${AI_LABEL}`);
  const ai = toAiImages({ hook: 'h', scene: 'cover scene', caption: 'c' }, [{ hook: 'a', scene: 's1 scene', caption: 'x' }, { hook: 'b', scene: '', caption: '' }], ['One', 'Two']);
  assert.deepEqual(ai.map((i) => [i.id, i.section]), [['cover', ''], ['s1', 'One']]);
  assert.deepEqual(cleanAiImages([{ id: 'evil', scene: 'x' }, { id: 's2', section: 'Two', hook: 'h', scene: 's', caption: 'c' }]).map((i) => i.id), ['s2']);
});

test('image hooks are checked like the text: secrets, recent tickers and made-up numbers', () => {
  const a = {
    draft: 'Body text.', answers: [], material: { hiddenTickers: ['RELIANCE'], images: [], facts: ['lost in 8 of 9 months'] } as unknown as Material,
    kit: { title: '', subtitle: '', tags: [], captions: {}, ai: [{ id: 'cover', section: '', hook: 'RELIANCE crashed 40%', scene: 'gap fade on screen', caption: '' }] },
  };
  const c = checkDraft(a, ['gap fade']);
  assert.deepEqual(c.tickers, ['RELIANCE']);
  assert.deepEqual(c.secrets, ['gap fade']);
  assert.ok(c.unknownNumbers.includes('40'));
  assert.equal(c.blocked, true);
});

/* ---------------- his voice ---------------- */

test('sign-off is added once at the end, before the disclaimer, and does not count against his words', async () => {
  const { withSignOff, DEFAULT_SIGN_OFF } = await import('../lib/medium/voice');
  const d = withDisclaimer(withSignOff('I had it live in three hours.\n\nThanks for reading!\nold subscribe line'), false);
  assert.equal(d.split('Thanks for reading!').length, 2);
  assert.ok(!d.includes('old subscribe line'));
  assert.ok(d.indexOf('Subscribe here') < d.indexOf(DISCLAIMER_MARK));
  assert.ok(yourWordsShare(d, ['I had it live in three hours']) > 0.95);
  assert.equal(withSignOff('Body.', ''), 'Body.');
  assert.ok(DEFAULT_SIGN_OFF.includes('https://medium.com/@niskarshk/subscribe'));
});

test('links in the draft become real links when pasted into Medium', () => {
  const h = toMediumHtml('Make sure you get my articles — [Subscribe here](https://medium.com/@niskarshk/subscribe).', []);
  assert.match(h, /<a href="https:\/\/medium\.com\/@niskarshk\/subscribe">Subscribe here<\/a>/);
  assert.ok(!toMediumHtml('[x](javascript:alert(1))', []).includes('<a '));
});

test('settings carry the writing style and sign-off, an empty sign-off stays empty', async () => {
  const { DEFAULT_WRITING_STYLE, DEFAULT_SIGN_OFF } = await import('../lib/medium/voice');
  assert.equal(defaultSettings().writingStyle, DEFAULT_WRITING_STYLE);
  assert.equal(cleanSettings({}).signOff, DEFAULT_SIGN_OFF);
  assert.equal(cleanSettings({ signOff: '' }).signOff, '');
  assert.equal(cleanSettings({ writingStyle: '  ' }).writingStyle, DEFAULT_WRITING_STYLE);
});

test('the writing style covers his fragments and dash rhythm', async () => {
  const { DEFAULT_WRITING_STYLE } = await import('../lib/medium/voice');
  assert.match(DEFAULT_WRITING_STYLE, /fragments and phrases/);
  assert.match(DEFAULT_WRITING_STYLE, /correcting himself mid-sentence/);
  assert.match(DEFAULT_WRITING_STYLE, /do not "fix" them into commas/);
});
