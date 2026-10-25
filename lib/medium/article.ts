/**
 * The Medium page's rules, all pure (used by the server, the page and the tests). Medium's API is closed, so
 * tradereye only prepares: he pastes and publishes by hand. Everything here protects the two assets:
 *  - his Partner Program account: the article must be mostly his own words (Medium does not allow AI-generated
 *    writing behind the paywall), with no invented experience, number or quote
 *  - his edge: secret terms (kept encrypted in settings) never go out, and the Algo Lab story only carries
 *    process and results (see lib/medium/source.ts)
 * plus SEBI: no tips or buy/sell calls, a risk disclaimer added by code, tickers only for trades over 92 days old.
 */

export type Format = 'weekly' | 'vs-algo' | 'building' | 'monthly';
export const FORMATS: { id: Format; name: string; what: string }[] = [
  { id: 'weekly', name: 'Weekly trade log', what: 'The week\'s journal trades, wins and losses, one lesson' },
  { id: 'vs-algo', name: 'Me vs Algo', what: 'The frozen season ledger and Algo Live\'s trades' },
  { id: 'building', name: 'Building tradereye', what: 'Algo Lab iterations: what was built, what failed' },
  { id: 'monthly', name: 'Monthly review', what: 'The month\'s P&L, hit rate, what changed' },
];

/** One trade as the article may show it. `label` is the ticker only when the trade is over 92 days old. */
export interface ArticleTrade {
  id: string; date: string; label: string; showTicker: boolean; dir: 'LONG' | 'SHORT'; side?: 'me' | 'algo';
  entryTime: string; exitTime: string; holdMin: number; result: string; netR?: number; net: number; exitType: string;
  comment?: string;
}

/** The pictures tradereye draws from real data (never AI-generated). Data is everything the renderer needs. */
export type ImageKind = 'banner' | 'trade' | 'scoreboard' | 'equity' | 'iterations';
export interface Candle { t: number; o: number; h: number; l: number; c: number }
export interface TradeChart { label: string; date: string; dir: 'LONG' | 'SHORT'; candles: Candle[]; marks: { t: number; price: number; role: 'ENTRY' | 'ADD' | 'EXIT' }[]; stop?: number; result: string }
export type ImageData =
  | { kind: 'banner' }
  | { kind: 'trade'; chart: TradeChart }
  | { kind: 'scoreboard'; weeks: { week: string; me: number; algo: number; winner: string }[]; season: { me: number; algo: number } }
  | { kind: 'equity'; unit: 'R' | '₹'; points: { label: string; value: number }[] }
  | { kind: 'iterations'; bars: { label: string; value: number; note?: string }[] };
export interface ImageSpec { id: string; title: string; caption: string; data: ImageData }

/** The real data one article is built from. `facts` is exactly what Claude sees (and nothing else). */
export interface Material {
  format: Format;
  period: { from: string; to: string; label: string };
  facts: string[];
  trades: ArticleTrade[];
  images: ImageSpec[];
  /** tickers of trades under 92 days old: never in the text */
  hiddenTickers: string[];
  /** Algo Lab "what changed" lines: offered to him one by one, unticked (private) by default */
  changes?: { iteration: number; text: string }[];
  /** every price shown is older than 3 months (adds the old-data line to the disclaimer) */
  oldPrices: boolean;
}

export interface Kit { title: string; subtitle: string; tags: string[]; captions: Record<string, string>; publication?: string }
export interface Article {
  v: 1; id: string; format: Format; createdAt: number; updatedAt: number;
  material: Material;
  /** indexes into material.changes he marked safe to share */
  shared: number[];
  questions: string[];
  answers: string[];
  /** markdown-lite: "## " headings, "- " lists, **bold**, and "[IMAGE <id>]" lines where an image goes */
  draft: string;
  kit?: Kit;
  published?: { url: string; at: number };
  deleted?: boolean;
  /** what Claude cost on this article, ₹ */
  costInr: number;
}
export interface ArticleHead {
  id: string; format: Format; period: string; title: string; createdAt: number; updatedAt: number; published?: { url: string; at: number }; deleted?: boolean;
  /** Building tradereye: the iterations it covers (for the series links) */
  iterations?: [number, number];
}
export const headOf = (a: Article): ArticleHead => ({
  id: a.id, format: a.format, period: a.material.period.label, title: a.kit?.title || `${FORMATS.find((f) => f.id === a.format)!.name}: ${a.material.period.label}`,
  createdAt: a.createdAt, updatedAt: a.updatedAt, published: a.published, deleted: a.deleted,
  ...(a.format === 'building' ? { iterations: [Number(a.material.period.from), Number(a.material.period.to)] as [number, number] } : {}),
});

/**
 * The series block for a Building tradereye part: links to the published parts that came before it (earlier
 * iterations), oldest first, so readers can find part 1. Empty when none is published yet.
 */
export function seriesLinks(a: Pick<Article, 'format' | 'material'>, heads: ArticleHead[]): { label: string; title: string; url: string }[] {
  if (a.format !== 'building') return [];
  const from = Number(a.material.period.from);
  return heads
    .filter((h) => h.format === 'building' && h.published && !h.deleted && h.iterations && h.iterations[1] < from)
    .sort((x, y) => x.iterations![0] - y.iterations![0])
    .map((h) => ({ label: h.iterations![0] === h.iterations![1] ? `Part ${h.iterations![0]}` : `Iterations ${h.iterations![0]}–${h.iterations![1]}`, title: h.title, url: h.published!.url }));
}

/* ---------------- settings: publications and secret terms ---------------- */

export interface Publication { name: string; url: string; fits: Format[]; never?: boolean; note?: string }
export interface Settings { v: 1; publications: Publication[]; secretTerms: string[] }

const ALL: Format[] = ['weekly', 'vs-algo', 'building', 'monthly'];
/** The publications he writes for (Oct 2026), ranked best fit first per format. */
export const DEFAULT_PUBLICATIONS: Publication[] = [
  { name: 'AI Advances', url: 'https://medium.com/ai-advances', fits: ['building', 'vs-algo'] },
  { name: 'Technology Hits', url: 'https://medium.com/technology-hits', fits: ['building', 'vs-algo'] },
  { name: 'ILLUMINATION', url: 'https://medium.com/illumination', fits: ALL },
  { name: 'Readers Hope', url: 'https://medium.com/readers-digests', fits: ['weekly', 'monthly'] },
  { name: 'ILLUMINATION\'S MIRROR', url: 'https://medium.com/illuminations-mirror', fits: ALL },
  { name: 'Everyday AI', url: 'https://medium.com/everyday-ai', fits: ['building'] },
  { name: 'AI Advances Briefs', url: 'https://medium.com/ai-advances-briefs', fits: [], note: 'short pieces only' },
  { name: 'SYNERGY', url: 'https://medium.com/technical-excellence', fits: [], note: 'writing and blogging' },
  { name: 'Neurostrategy for Creators', url: 'https://medium.com/substack-mastery-boost', fits: [], note: 'newsletter summaries' },
  { name: 'Magnetic Newsletter Pro', url: 'https://medium.com/illumination-curators-on-substack', fits: [], note: 'newsletter writers' },
  { name: 'Health and Science', url: 'https://medium.com/health-science', fits: [] },
  { name: 'ILLUMINATION Gaming', url: 'https://medium.com/illumination-gaming', fits: [] },
  { name: 'ILLUMINATION Book Chapters', url: 'https://medium.com/illumination-book-chapters', fits: [] },
  { name: 'ILLUMINATION Videos and Podcasts', url: 'https://medium.com/illumination-on-youtube', fits: [] },
  { name: 'Lampshade of ILLUMINATION', url: 'https://medium.com/lampshade-of-illumination', fits: [], never: true,
    note: 'publishes only AI-generated content: would label his work AI on his Partner Program account' },
];
export const defaultSettings = (): Settings => ({ v: 1, publications: DEFAULT_PUBLICATIONS.map((p) => ({ ...p, fits: [...p.fits] })), secretTerms: [] });

/** Publications that fit this format, best first. Never one marked `never`. */
export function suggestPublications(format: Format, pubs: Publication[]): Publication[] {
  return pubs.filter((p) => !p.never && p.fits.includes(format));
}

export function cleanSettings(x: unknown): Settings {
  const s = (x ?? {}) as Partial<Settings>;
  const pubs = Array.isArray(s.publications) ? s.publications : [];
  return {
    v: 1,
    publications: pubs
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .slice(0, 40)
      .map((p) => ({
        name: p.name.trim().slice(0, 80), url: /^https:\/\/medium\.com\/[\w.-]+$/.test(String(p.url ?? '').trim()) ? String(p.url).trim() : '',
        fits: (Array.isArray(p.fits) ? p.fits : []).filter((f): f is Format => ALL.includes(f as Format)),
        ...(p.never ? { never: true } : {}), ...(p.note ? { note: String(p.note).slice(0, 160) } : {}),
      })),
    secretTerms: [...new Set((Array.isArray(s.secretTerms) ? s.secretTerms : []).map((t) => String(t).trim()).filter((t) => t.length >= 2))].slice(0, 200).map((t) => t.slice(0, 80)),
  };
}

/* ---------------- the checks ---------------- */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** whole-word, case-insensitive (a term that starts / ends with a symbol still matches) */
const termRe = (t: string, flags = 'iu') => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(t)}(?=$|[^\\p{L}\\p{N}_])`, flags);

/** Secret terms found in the text: any hit blocks Copy. */
export const secretHits = (text: string, terms: string[]) => terms.filter((t) => t.trim() && termRe(t.trim()).test(text));

/**
 * Tickers of recent trades found in the text: SEBI's 3-month rule, any hit blocks Copy. Matched in capitals (and as a
 * hashtag in any case), so a ticker that is also a word ("IDEA") does not block "a good idea".
 */
export const tickerHits = (text: string, hidden: string[]) => hidden.filter((t) => termRe(t, 'u').test(text) || termRe(`#${t}`).test(text));

/** Phrases that read as a tip or a call. Shown as warnings (he decides), the prompt already forbids them. */
const ADVICE: [RegExp, string][] = [
  [/\byou (should|must|need to) (buy|sell|short|go long|enter|hold|book)\b/i, 'tells the reader to trade'],
  [/\b(buy|sell|short|accumulate) (now|today|this week|on dips?|at)\b/i, 'a buy / sell call'],
  [/\b(strong buy|sure[- ]?shot|multibagger|guaranteed|can'?t lose|easy money|risk[- ]free)\b/i, 'a promise'],
  [/\b(price target|target price)\b/i, 'a price target'],
  [/\bstocks? to (watch|buy)\b/i, 'a stock pick'],
  [/\bwill (rise|fall|go up|go down|rally|crash|double)\b/i, 'a prediction'],
];
export function adviceHits(text: string): { phrase: string; why: string }[] {
  const out: { phrase: string; why: string }[] = [];
  for (const [re, why] of ADVICE) { const m = text.match(re); if (m) out.push({ phrase: m[0], why }); }
  return out;
}

const NUM = /[-+−]?₹?\s?\d[\d,]*(?:\.\d+)?/g;
const toNum = (s: string) => parseFloat(s.replace(/[₹\s,+]/g, '').replace('−', '-'));
/** every number in a text, as values */
export const numbersIn = (text: string) => (text.match(NUM) ?? []).map(toNum).filter((n) => Number.isFinite(n));

/**
 * Numbers in the draft that are in neither the data nor his answers: the likeliest invented facts. Matches allow
 * rounding (14.37 in the data covers 14.4 and 14 in the draft) and sign. Dates and the image markers are skipped.
 */
export function unknownNumbers(draft: string, sources: string[]): string[] {
  const known = sources.flatMap(numbersIn).map(Math.abs);
  const body = draft.replace(/\[IMAGE [^\]]+\]/g, '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
  const bad = new Set<string>();
  for (const raw of body.match(NUM) ?? []) {
    const n = Math.abs(toNum(raw));
    if (!Number.isFinite(n)) continue;
    const dp = (raw.split('.')[1] ?? '').length;
    const ok = known.some((k) => Math.abs(k - n) < 1e-9 || Number(k.toFixed(dp)) === n || (dp === 0 && Math.round(k) === n && Math.abs(k) >= 1));
    if (!ok) bad.add(raw.trim());
  }
  return [...bad];
}

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
/** The article's own text: no headings, image markers or disclaimer. */
export function bodyText(draft: string): string {
  return draft.split('\n').filter((l) => !/^\s*#{1,3}\s/.test(l) && !/^\s*\[IMAGE [^\]]+\]\s*$/.test(l) && !l.includes(DISCLAIMER_MARK)).join('\n');
}

/**
 * How much of the draft is his words: the share of the body's words that sit inside a run of 3+ words also found in
 * his answers. Reordering and trimming keep the score; rewording drops it. Under 0.8 the page warns.
 */
export function yourWordsShare(draft: string, answers: string[]): number {
  const d = words(bodyText(draft));
  if (!d.length) return 0;
  const grams = new Set<string>();
  for (const a of answers) { const w = words(a); for (let i = 0; i + 2 < w.length; i++) grams.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`); }
  const covered = new Array(d.length).fill(false);
  for (let i = 0; i + 2 < d.length; i++) if (grams.has(`${d[i]} ${d[i + 1]} ${d[i + 2]}`)) covered[i] = covered[i + 1] = covered[i + 2] = true;
  return covered.filter(Boolean).length / d.length;
}
export const YOUR_WORDS_MIN = 0.8;

export interface Checks { yourWords: number; secrets: string[]; tickers: string[]; advice: { phrase: string; why: string }[]; unknownNumbers: string[]; missingImages: string[]; blocked: boolean }
/** Everything the page shows under the draft. Secret terms and recent tickers block copying. */
export function checkDraft(a: Pick<Article, 'draft' | 'answers' | 'material' | 'kit'>, secretTerms: string[]): Checks {
  const all = [a.draft, a.kit?.title ?? '', a.kit?.subtitle ?? '', ...Object.values(a.kit?.captions ?? {})].join('\n');
  const secrets = secretHits(all, secretTerms), tickers = tickerHits(all, a.material.hiddenTickers);
  const placed = new Set([...a.draft.matchAll(/\[IMAGE ([^\]]+)\]/g)].map((m) => m[1].trim()));
  return {
    yourWords: yourWordsShare(a.draft, a.answers),
    secrets, tickers, advice: adviceHits(all),
    unknownNumbers: unknownNumbers(bodyText(a.draft), [...a.material.facts, ...a.answers]),
    missingImages: a.material.images.filter((i) => i.data.kind !== 'banner' && !placed.has(i.id)).map((i) => i.id),
    blocked: secrets.length > 0 || tickers.length > 0,
  };
}

/* ---------------- disclaimer and the pasteable article ---------------- */

export const DISCLAIMER_MARK = 'not a SEBI-registered';
export const ARTICLE_DISCLAIMER = [
  'Disclaimer: I am not a SEBI-registered investment adviser or research analyst. This is my own trading, shared as a',
  'personal journal for information and education only. It is not investment advice or a recommendation to buy, sell',
  'or hold any security. Trading carries a high risk of loss; past results do not guarantee future returns. Do your',
  'own research or consult a SEBI-registered adviser before trading.',
].join(' ');
export const OLD_PRICES_LINE = 'Prices and charts shown are more than 3 months old.';

/** The disclaimer, added once at the end by code (an edit cannot drop it: it is re-added on every save). */
export function withDisclaimer(draft: string, oldPrices: boolean): string {
  const lines = draft.trimEnd().split('\n').filter((l) => !l.includes(DISCLAIMER_MARK) && !l.includes(OLD_PRICES_LINE));
  while (lines.length && (!lines[lines.length - 1].trim() || lines[lines.length - 1].trim() === '---')) lines.pop();
  return [...lines, '', '---', '', `*${ARTICLE_DISCLAIMER}${oldPrices ? ` ${OLD_PRICES_LINE}` : ''}*`].join('\n');
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) => html(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');

/**
 * The draft as HTML for Medium's editor (pasted as rich text keeps headings, bold, italics, lists, quotes and
 * dividers). Image markers become a visible line saying which download goes there.
 */
export function toMediumHtml(draft: string, images: ImageSpec[]): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of draft.split('\n')) {
    const l = raw.trimEnd();
    const li = l.match(/^\s*[-*]\s+(.*)$/);
    if (li) { list.push(li[1]); continue; }
    flush();
    if (!l.trim()) continue;
    const img = l.match(/^\s*\[IMAGE ([^\]]+)\]\s*$/);
    const h = l.match(/^\s*(#{1,3})\s+(.*)$/);
    if (img) {
      const spec = images.find((i) => i.id === img[1].trim());
      out.push(`<p><strong>[Image: ${html(spec?.title ?? img[1])}]</strong>${spec?.caption ? ` ${html(spec.caption)}` : ''}</p>`);
    } else if (h) out.push(h[1].length === 1 ? `<h1>${inline(h[2])}</h1>` : h[1].length === 2 ? `<h3>${inline(h[2])}</h3>` : `<h4>${inline(h[2])}</h4>`);
    else if (l.trim() === '---') out.push('<hr>');
    else if (l.startsWith('> ')) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return out.join('\n');
}

/** The same draft as plain text (the clipboard's fallback). */
export const toPlain = (draft: string) => draft.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*#{1,3}\s+/gm, '').replace(/\*([^*]+)\*/g, '$1');

/* ---------------- what Claude returns, cleaned ---------------- */

/** Medium allows 5 tags: lower case, letters / digits / spaces / hyphens, at most 25 characters each. */
export function cleanTags(tags: unknown): string[] {
  const seen = new Set<string>();
  for (const t of Array.isArray(tags) ? tags : []) {
    const s = String(t).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 25);
    if (s) seen.add(s);
    if (seen.size === 5) break;
  }
  return [...seen];
}

/** Keeps only image markers that exist; adds none (missing ones are listed by checkDraft). */
export function cleanDraft(draft: unknown, images: ImageSpec[]): string {
  const ids = new Set(images.map((i) => i.id));
  return String(draft ?? '').slice(0, 30_000).split('\n')
    .filter((l) => { const m = l.match(/^\s*\[IMAGE ([^\]]+)\]\s*$/); return !m || ids.has(m[1].trim()); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The published story's address, or null. Any https address: some publications use their own domain (not medium.com). */
export function cleanMediumUrl(u: unknown): string | null {
  try {
    const x = new URL(String(u ?? '').trim());
    if (x.protocol !== 'https:' || !x.hostname.includes('.') || x.pathname.length < 3) return null;
    x.search = ''; x.hash = '';
    return x.toString();
  } catch { return null; }
}

/* ---------------- edits from the page ---------------- */

export interface Patch {
  shared?: number[]; questions?: string[]; answers?: string[]; draft?: string;
  kit?: Partial<Kit>; publishedUrl?: string | null; deleted?: boolean;
}

/**
 * Applies his edits, cleaned. The disclaimer is put back on every draft save (an edit cannot drop it), the tags stay
 * Medium-valid, a publication marked `never` cannot be chosen, and a published link must be an https address.
 */
export function applyPatch(a: Article, p: Patch, pubs: Publication[], now = Date.now()): { article: Article; error?: string } {
  const next: Article = { ...a, updatedAt: now };
  const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
  if (p.shared) next.shared = [...new Set(p.shared.filter((i) => Number.isInteger(i) && i >= 0 && i < (a.material.changes?.length ?? 0)))];
  if (p.questions) next.questions = p.questions.slice(0, 5).map((q) => clip(q, 240));
  if (p.answers) next.answers = p.answers.slice(0, 5).map((x) => clip(x, 6000));
  if (p.draft !== undefined) next.draft = p.draft.trim() ? withDisclaimer(cleanDraft(p.draft, a.material.images), a.material.oldPrices) : '';
  if (p.kit) {
    const k = { title: '', subtitle: '', tags: [], captions: {}, ...a.kit, ...p.kit };
    if (k.publication && pubs.find((x) => x.name === k.publication)?.never) return { article: a, error: `${k.publication} publishes only AI-generated content: not for your articles.` };
    next.kit = {
      title: clip(k.title, 100), subtitle: clip(k.subtitle, 160), tags: cleanTags(k.tags), publication: k.publication ? clip(k.publication, 80) : undefined,
      captions: Object.fromEntries(Object.entries(k.captions ?? {}).filter(([id]) => a.material.images.some((i) => i.id === id)).map(([id, c]) => [id, clip(c, 160)])),
    };
  }
  if (p.publishedUrl !== undefined) {
    if (p.publishedUrl === null || p.publishedUrl === '') next.published = undefined;
    else {
      const url = cleanMediumUrl(p.publishedUrl);
      if (!url) return { article: a, error: 'That is not a story address (https://...).' };
      next.published = { url, at: a.published?.at ?? now };
    }
  }
  if (p.deleted !== undefined) next.deleted = !!p.deleted;
  return { article: next };
}
