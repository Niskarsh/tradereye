/**
 * The research iterations (12 on) price some versions at a position size (₹10 / ₹5 lakh), but ml_walkforward.py, which they
 * run on unchanged, labels every money figure and the first "same trades at other sizes" row as ₹300 risk. relabelSized()
 * corrects a loaded iteration in place of those labels, so the Algo Lab page and the Markdown export (lib/ml/exportMd.ts)
 * both say what each number really is. Older iterations, and versions without a size, pass through unchanged.
 */

/** the position a version is priced at, in lakh: w10_f170_c3 / w5_aware_c2 / nT10 / (iteration 13) wT15; null = ₹300 risk */
export function sizeLakh(id: string): number | null {
  const m = /^w(\d+)_/.exec(id) ?? /^[nw]T(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export const NO_TRADE_NOTE = 'no trade passed the bar';
export const PLACEBO_NAME = 'Placebo, ₹300 risk, all stocks (shuffled outcomes)';

interface MoneyIn {
  stopPct?: number; position?: number; margin?: number; maxPerDay?: number; tradesPerMonth?: number; perTrade?: number; perMonth?: number;
  worstMonth?: number; bestMonth?: number; maxDrawdownR?: number; capital?: number; pct?: number; bigger?: unknown[];
  /** set here: the risk a trade the rupees are at, and which size */ riskInr?: number; sizeLabel?: string;
}
interface StratIn { id: string; name: string; money?: MoneyIn | null; costs?: { name: string }[] | null; months?: { n?: number; note?: string }[] }
interface MlIn { wide?: unknown; strategies: StratIn[] }

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
    ...m, position, margin: Math.round(margin), riskInr: Math.round(risk), sizeLabel: `₹${lakh} lakh positions`,
    perTrade: Math.round((m.perTrade ?? 0) * k), perMonth, worstMonth: Math.round((m.worstMonth ?? 0) * k), bestMonth: Math.round((m.bestMonth ?? 0) * k),
    capital: Math.round(capital), pct: capital > 0 ? Math.round((1000 * perMonth) / capital) / 10 : 0, bigger: [],
  };
}

/** a copy of a loaded iteration with the size labels corrected (no-op before iteration 12 or for ₹300-risk versions) */
export function relabelSized<T extends MlIn>(ml: T): T {
  if (!ml.wide) return ml;
  return {
    ...ml,
    strategies: ml.strategies.map((s) => {
      const lakh = sizeLakh(s.id);
      const months = s.months?.map((m) => (!m.n && !m.note ? { ...m, note: NO_TRADE_NOTE } : m));
      const out = { ...s, months };
      if (s.id === 'placebo') return { ...out, name: PLACEBO_NAME };
      if (lakh == null) return out;
      return {
        ...out,
        money: s.money ? sizedMoney(s.money, lakh) : s.money,
        costs: s.costs?.map((c, i) => (i === 0 ? { ...c, name: `As priced (₹${lakh} lakh positions)` } : c)),
      };
    }),
  };
}
