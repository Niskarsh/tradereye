/**
 * Algo Lab iteration 17, data beyond Dhan's candles (research only):
 *   - each stock's sector: its industry in NSE's Nifty 500 list, mapped to an NSE sector index Dhan has candles for
 *     (a stock outside the Nifty 500, or in an industry without an index, has no sector facts);
 *   - results days: NSE's board-meeting calendar, meetings whose purpose is financial results.
 * Both are best effort: when a source cannot be read the run goes on without it and the results say so.
 */

/* ---- sectors ------------------------------------------------------------------------------------------------- */

export const NIFTY500_LIST_URLS = [
  'https://niftyindices.com/IndexConstituent/ind_nifty500list.csv',
  'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
];

/** NSE industry (the Nifty 500 list's "Industry" column) -> the index to read it from, by the names Dhan may list it under */
export const INDUSTRY_INDEX: Record<string, string[]> = {
  // Dhan's own trading symbols first (its instrument list, Nov 2026), then other names NSE has used
  'Information Technology': ['NIFTYIT', 'NIFTY IT'],
  'Automobile and Auto Components': ['NIFTY AUTO'],
  'Financial Services': ['FINNIFTY', 'NIFTY FIN SERVICE'],
  'Healthcare': ['NIFTY HEALTHCARE', 'NIFTY PHARMA'],
  'Fast Moving Consumer Goods': ['NIFTY FMCG'],
  'Metals & Mining': ['NIFTY METAL'],
  'Oil Gas & Consumable Fuels': ['NIFTY OIL AND GAS', 'NIFTY ENERGY'],
  'Power': ['NIFTY ENERGY'],
  'Realty': ['NIFTY REALTY'],
  'Media Entertainment & Publication': ['NIFTY MEDIA'],
  'Consumer Durables': ['NIFTY CONSR DURBL'],
  'Chemicals': ['NIFTY COMMODITIES'], // no chemicals index on Dhan: the commodities index holds the big chemical names
  'Capital Goods': ['NIFTY INDIA MFG', 'NIFTYINFRA'],
  'Construction': ['NIFTYINFRA'],
  'Construction Materials': ['NIFTYINFRA'],
  'Telecommunication': ['NIFTYINFRA'],
  'Consumer Services': ['NIFTY CONSUMPTION'],
  'Services': ['NIFTY SERV SECTOR'],
  // Textiles, Diversified, Forest Materials: no index (no sector facts)
};
/** a copy of NSE's Nifty 500 list kept in the repo (Nov 2026), used when NSE's site cannot be reached from GitHub */
export const NIFTY500_LIST_FILE = 'scripts/data/ind_nifty500list.csv';

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

/** symbol -> industry, from NSE's Nifty 500 list CSV (columns Company Name, Industry, Symbol, Series, ISIN Code) */
export function parseIndustries(csv: string): Map<string, string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const out = new Map<string, string>();
  if (lines.length < 2) return out;
  const head = splitCsv(lines[0]).map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
  const iSym = head.indexOf('symbol'), iInd = head.indexOf('industry');
  if (iSym < 0 || iInd < 0) return out;
  for (const l of lines.slice(1)) {
    const f = splitCsv(l);
    const sym = (f[iSym] ?? '').trim().toUpperCase(), ind = (f[iInd] ?? '').trim();
    if (sym && ind) out.set(sym, ind);
  }
  return out;
}

/** NSE index name (normalised: letters and digits only) -> Dhan security id, from Dhan's instrument list */
export function parseIndexIds(csv: string): Map<string, string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const out = new Map<string, string>();
  if (lines.length < 2) return out;
  const head = splitCsv(lines[0]).map((h) => h.trim().replace(/^﻿/, ''));
  const pick = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iExch = pick('SEM_EXM_EXCH_ID', 'EXCH_ID'), iSeg = pick('SEM_SEGMENT', 'SEGMENT'), iId = pick('SEM_SMST_SECURITY_ID', 'SECURITY_ID');
  const iInst = pick('SEM_INSTRUMENT_NAME', 'INSTRUMENT');
  const names = ['SEM_TRADING_SYMBOL', 'SEM_CUSTOM_SYMBOL', 'SM_SYMBOL_NAME', 'UNDERLYING_SYMBOL', 'SYMBOL_NAME', 'DISPLAY_NAME'].map((n) => head.indexOf(n)).filter((i) => i >= 0);
  for (const l of lines.slice(1)) {
    const f = splitCsv(l);
    if (iExch >= 0 && f[iExch] !== 'NSE') continue;
    if (iSeg >= 0 && f[iSeg] !== 'I') continue;
    if (iInst >= 0 && f[iInst] !== 'INDEX') continue;
    const id = (f[iId] ?? '').trim();
    if (!id) continue;
    for (const i of names) { const n = norm(f[i] ?? ''); if (n && !out.has(n)) out.set(n, id); }
  }
  return out;
}

export interface SectorPlan {
  /** symbol -> the index it is read from */
  bySymbol: Map<string, { index: string; securityId: string }>;
  /** the indices to fetch */
  indices: { name: string; securityId: string }[];
  /** industries with no index found */
  missing: string[];
}

/** which index each stock's sector is read from (first of INDUSTRY_INDEX's names that Dhan lists) */
export function sectorPlan(industries: Map<string, string>, indexIds: Map<string, string>): SectorPlan {
  const resolved = new Map<string, { index: string; securityId: string } | null>();
  for (const [ind, names] of Object.entries(INDUSTRY_INDEX)) {
    const hit = names.map((n) => ({ n, id: indexIds.get(norm(n)) })).find((x) => x.id);
    resolved.set(ind, hit ? { index: hit.n, securityId: hit.id! } : null);
  }
  const bySymbol = new Map<string, { index: string; securityId: string }>();
  const missing = new Set<string>();
  for (const [sym, ind] of industries) {
    const r = resolved.get(ind);
    if (r) bySymbol.set(sym, r); else missing.add(ind);
  }
  const indices = [...new Map([...bySymbol.values()].map((x) => [x.securityId, { name: x.index, securityId: x.securityId }])).values()];
  return { bySymbol, indices, missing: [...missing].sort() };
}

/* ---- results days --------------------------------------------------------------------------------------------- */

const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** "15-Jan-2024" / "15-01-2024" / "2024-01-15" -> "2024-01-15" */
export function nseDate(s: string): string | undefined {
  const t = s.trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(t);
  if (m && MON[m[2].toUpperCase()]) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** results meetings in NSE's board-meeting reply: symbol -> dates */
export function parseBoardMeetings(raw: unknown, into = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : [];
  for (const x of list as Record<string, unknown>[]) {
    const sym = String(x.bm_symbol ?? x.symbol ?? '').trim().toUpperCase();
    const purpose = `${x.bm_purpose ?? x.purpose ?? ''} ${x.bm_desc ?? x.desc ?? ''}`;
    const date = nseDate(String(x.bm_date ?? x.date ?? ''));
    if (!sym || !date || !/result/i.test(purpose)) continue;
    const set = into.get(sym) ?? new Set<string>();
    set.add(date); into.set(sym, set);
  }
  return into;
}

/** results meetings from NSE, a month at a time (cookie from NSE's home page first, as a browser would) */
export async function fetchResultsDays(from: string, to: string, fetchImpl: typeof fetch = fetch, log: (m: string) => void = () => {}): Promise<Map<string, Set<string>>> {
  const home = await fetchImpl(NSE, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const out = new Map<string, Set<string>>();
  const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  for (let m = from.slice(0, 7); m <= to.slice(0, 7);) {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const url = `${NSE}/api/corporate-board-meetings?index=equities&from_date=${dmy(`${m}-01`)}&to_date=${dmy(last)}`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${NSE}/companies-listing/corporate-filings-board-meetings`, Cookie: cookie } });
    if (!res.ok) throw new Error(`NSE board meetings ${m}: HTTP ${res.status}`);
    parseBoardMeetings(await res.json(), out);
    log(`results calendar ${m}: ${[...out.values()].reduce((a, s) => a + s.size, 0)} results meetings so far`);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

/**
 * 1 if the company's results meeting fell on this session or on / after the session before it (results often come after the
 * close or at a weekend, so the next session is the one that reacts): a meeting on any day from the previous session up to today.
 */
export function resultsFlag(days: Set<string> | undefined, date: string, prevSession: string | undefined): number {
  if (!days) return 0;
  for (const d of days) if (d <= date && (prevSession === undefined ? d === date : d >= prevSession)) return 1;
  return 0;
}
