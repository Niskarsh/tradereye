import { colLetter, rowToObject, type SheetsClient } from '../sheetsApi';
import { settings } from './settings';

/**
 * Settings you change from the app (no redeploy): kept in a small "copilot-settings" tab of your sheet, one
 * Key / Value row each. Today that is your max risk per trade. If the tab or the row is missing, the default is
 * COPILOT_RISK_INR from Vercel, else 300.
 */

export const TAB_COPILOT_SETTINGS = 'copilot-settings';
const COLS = ['Key', 'Value', 'UpdatedAt'] as const;
let cached: { at: number; risk: number } | null = null;

export async function getRiskInr(sheets: SheetsClient, now = Date.now()): Promise<number> {
  if (cached && now - cached.at < 60_000) return cached.risk;
  let risk = settings().riskInr;
  try {
    const tab = await sheets.findTab(TAB_COPILOT_SETTINGS);
    if (tab) {
      const { headers, rows } = await sheets.readTail(TAB_COPILOT_SETTINGS, 50);
      const row = rows.map((r) => rowToObject(headers, r.cells)).find((o) => o.Key === 'RiskInr');
      const v = parseFloat(row?.Value ?? '');
      if (Number.isFinite(v) && v > 0) risk = v;
    }
  } catch { /* fall back to the default */ }
  cached = { at: now, risk };
  return risk;
}

export async function setRiskInr(sheets: SheetsClient, value: number, now = Date.now()): Promise<number> {
  if (!(Number.isFinite(value) && value > 0 && value <= 100_000)) throw new Error('Risk must be a positive number of rupees.');
  const v = Math.round(value);
  const { headers } = await sheets.ensureTab(TAB_COPILOT_SETTINGS, COLS);
  const { rows } = await sheets.readTail(TAB_COPILOT_SETTINGS, 50, headers);
  const hit = rows.find((r) => rowToObject(headers, r.cells).Key === 'RiskInr');
  const stamp = new Date(now + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  if (hit) {
    const q = `'${TAB_COPILOT_SETTINGS}'`;
    await sheets.updateRanges([
      { range: `${q}!${colLetter(headers.indexOf('Value'))}${hit.rowNumber}`, values: [[v]] },
      { range: `${q}!${colLetter(headers.indexOf('UpdatedAt'))}${hit.rowNumber}`, values: [[stamp]] },
    ], true);
  } else {
    await sheets.append(TAB_COPILOT_SETTINGS, [headers.map((h) => (h === 'Key' ? 'RiskInr' : h === 'Value' ? v : h === 'UpdatedAt' ? stamp : ''))], true);
  }
  cached = { at: now, risk: v };
  return v;
}
