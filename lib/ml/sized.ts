/**
 * The research iterations (12 on) price some versions at a position size (₹10 / ₹5 lakh), but ml_walkforward.py, which they
 * run on unchanged, labels every money figure and the first "same trades at other sizes" row as ₹300 risk. relabelSized()
 * corrects a loaded iteration in place of those labels, so the Algo Lab page and the Markdown export (lib/ml/exportMd.ts)
 * both say what each number really is. Older iterations, and versions without a size, pass through unchanged.
 */

/** the position a version is priced at, in lakh: w10_f170_c3 / w5_aware_c2 / w12_f100_c4_g / nT10 / (iteration 13) wT15; null = ₹300 risk */
export function sizeLakh(id: string): number | null {
  if (/^l\d+_/.test(id)) return null; // l5_f100_c3: a share of turnover, no fixed size; priced by ownMoney() from its `inr`
  const m = /^w(\d+)_/.exec(id) ?? /^[nw]T(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export const NO_TRADE_NOTE = 'no trade passed the bar';
export const PLACEBO_NAME = 'Placebo, ₹300 risk, all stocks (shuffled outcomes)';

interface MoneyIn {
  stopPct?: number; position?: number; margin?: number; maxPerDay?: number; tradesPerMonth?: number; perTrade?: number; perMonth?: number;
  worstMonth?: number; bestMonth?: number; maxDrawdownR?: number; capital?: number; pct?: number; bigger?: unknown[];
  /** set here: the risk a trade the rupees are at, and which size */ riskInr?: number; sizeLabel?: string;
  /** set here: 'size' = a fixed position at the median stop; 'own' = each trade's own position and stop (scripts/ml_wide.py rupees()) */ basis?: 'size' | 'own';
}
/** iteration 16 on: rupees from each trade's own position (fixed, or a share of the stock's turnover) and its own stop */
export interface OwnRupees { perMonth: number; examPerMonth?: number; avgPosition: number | null; avgRisk: number | null; capital: number }
interface StratIn { id: string; name: string; inr?: OwnRupees | null; money?: MoneyIn | null; costs?: { name: string }[] | null; months?: { n?: number; note?: string }[] }
interface MlIn { wide?: unknown; strategies: StratIn[]; /** set by relabelSized: already corrected, never scale again */ sized?: boolean }

/** iteration 15 on: the placebo runs at a size and says so in its name ("Placebo, ₹10 lakh · ₹100 cr+ · 4 a day") */
export function placeboLakh(name: string): number | null {
  const m = /^Placebo, ₹(\d+) lakh/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Money at the version's own size: the same R a trade, the rupees at its own risk (position x stop %), and the capital that
 * size needs (its margin at 5x for the most trades open at once, plus the deepest run of losses at its risk).
 */
export function sizedMoney<M extends MoneyIn>(m: M, lakh: number): M {
  const position = lakh * 100_000, risk = (position * (m.stopPct ?? 0)) / 100, k = risk / 300;
  const open = m.maxPerDay || 2; // trades open at once (always set by the pipeline; 2 if an old file lacks it)
  const margin = position / 5, capital = margin * open + (m.maxDrawdownR ?? 0) * risk;
  const perMonth = Math.round((m.perMonth ?? 0) * k);
  return {
    ...m, basis: 'size', position, margin: Math.round(margin), riskInr: Math.round(risk), sizeLabel: `₹${lakh} lakh positions`,
    perTrade: Math.round((m.perTrade ?? 0) * k), perMonth, worstMonth: Math.round((m.worstMonth ?? 0) * k), bestMonth: Math.round((m.bestMonth ?? 0) * k),
    capital: Math.round(capital), pct: capital > 0 ? Math.round((1000 * perMonth) / capital) / 10 : 0, bigger: [],
  };
}

/**
 * Money from the version's own positions (`inr`, iteration 16 on): the same basis as the liquidity table, so a fixed-size
 * reference (w10_…) and a turnover-sized version (l5_…) read alike. Per month and capital are exact from `inr`; per trade is
 * that month over the trades a month; worst / best month are at the average risk (the R figures stay as computed).
 */
export function ownMoney<M extends MoneyIn>(m: M, own: OwnRupees): M {
  const risk = own.avgRisk ?? 0, k = risk / 300, perMonth = own.perMonth;
  const lakh = own.avgPosition ? Math.round(own.avgPosition / 10_000) / 10 : null;
  return {
    ...m, basis: 'own', position: own.avgPosition ?? m.position, riskInr: Math.round(risk),
    sizeLabel: `its own positions (avg ₹${lakh ?? '–'} lakh)`,
    perTrade: m.tradesPerMonth ? Math.round(perMonth / m.tradesPerMonth) : m.perTrade, perMonth,
    worstMonth: Math.round((m.worstMonth ?? 0) * k), bestMonth: Math.round((m.bestMonth ?? 0) * k),
    capital: own.capital, pct: own.capital > 0 ? Math.round((1000 * perMonth) / own.capital) / 10 : 0, bigger: [],
  };
}

/**
 * A copy of a loaded iteration with the size labels corrected (no-op before iteration 12 or for ₹300-risk versions).
 * Idempotent: the result is marked `sized`, and a marked iteration comes back unchanged. The page relabels on load and the
 * Markdown export relabels what it is given, so without the mark the money was scaled twice (~77x at ₹10 lakh).
 */
export function relabelSized<T extends MlIn>(ml: T): T {
  if (!ml.wide || ml.sized) return ml;
  return {
    ...ml,
    sized: true,
    strategies: ml.strategies.map((s) => {
      const lakh = s.id === 'placebo' ? placeboLakh(s.name) : sizeLakh(s.id);
      const months = s.months?.map((m) => (!m.n && !m.note ? { ...m, note: NO_TRADE_NOTE } : m));
      const out = { ...s, months };
      // iterations 12-14 priced the placebo at ₹300 risk on all stocks under a plain name; from 15 its name says its own settings
      if (s.id === 'placebo' && s.name === 'Placebo (shuffled outcomes)') return { ...out, name: PLACEBO_NAME };
      if (s.inr && s.money) {
        return { ...out, money: ownMoney(s.money, s.inr), costs: s.costs?.map((c, i) => (i === 0 ? { ...c, name: 'As priced (its own positions)' } : c)) };
      }
      if (lakh == null) return out;
      return {
        ...out,
        money: s.money ? sizedMoney(s.money, lakh) : s.money,
        costs: s.costs?.map((c, i) => (i === 0 ? { ...c, name: `As priced (₹${lakh} lakh positions)` } : c)),
      };
    }),
  };
}
