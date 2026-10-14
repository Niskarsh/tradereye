/** Settings, from the server environment (all optional). */
export function settings() {
  const n = (v: string | undefined, d: number) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    riskInr: n(process.env.COPILOT_RISK_INR, 300),
    niftyDirPct: n(process.env.COPILOT_NIFTY_DIR_PCT, 0.15),
    emaReachAtr: n(process.env.COPILOT_EMA_REACH_ATR, 2),
    pocRows: Math.round(n(process.env.COPILOT_POC_ROWS, 24)),
    dailyLimit: Math.round(n(process.env.COPILOT_DAILY_LIMIT, 25)),
    model: process.env.COPILOT_MODEL?.trim() || 'claude-sonnet-5-5',
    usdInr: n(process.env.COPILOT_USD_INR, 88),
    thinking: (process.env.COPILOT_THINKING?.trim().toLowerCase() === 'on' ? 'on' : 'off') as 'on' | 'off',
  };
}
