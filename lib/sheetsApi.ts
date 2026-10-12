import { JWT } from 'google-auth-library';

/**
 * Thin Google Sheets REST wrapper for the live-capture and backfill features.
 * (The older routes keep using google-spreadsheet; this one exists because we need cheap batched
 * reads/writes, tail reads, and automatic column creation, and it is easy to test with a fake fetch.)
 */

export type Cell = string | number | boolean | null;

export interface TabInfo { title: string; sheetId: number; rowCount: number; columnCount: number }

export interface SheetsClientOptions {
  spreadsheetId: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export const colLetter = (index0: number): string => {
  let n = index0 + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

const q = (title: string) => `'${title.replace(/'/g, "''")}'`;

export class SheetsApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'SheetsApiError'; }
}

export class SheetsClient {
  private tabs: TabInfo[] | null = null;
  private tabsAt = 0;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private opts: SheetsClientOptions) {
    this.f = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? 'https://sheets.googleapis.com/v4/spreadsheets';
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.base}/${this.opts.spreadsheetId}${path}`;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = await this.opts.getToken();
      const res = await this.f(url, {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      lastErr = new SheetsApiError(res.status, `Sheets API ${res.status}: ${text.slice(0, 300)}`);
      if (res.status === 429 || res.status >= 500) { await this.sleep(800 * 2 ** attempt); continue; }
      break;
    }
    throw lastErr ?? new Error('Sheets API failed');
  }

  /* ---- tabs */

  async listTabs(force = false): Promise<TabInfo[]> {
    if (!force && this.tabs && Date.now() - this.tabsAt < 30_000) return this.tabs;
    const r = await this.call<{ sheets?: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(
      '?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))');
    this.tabs = (r.sheets ?? []).map((s) => ({
      title: s.properties.title, sheetId: s.properties.sheetId,
      rowCount: s.properties.gridProperties?.rowCount ?? 1000, columnCount: s.properties.gridProperties?.columnCount ?? 26,
    }));
    this.tabsAt = Date.now();
    return this.tabs;
  }

  async findTab(title: string, force = false): Promise<TabInfo | undefined> {
    return (await this.listTabs(force)).find((t) => t.title === title);
  }

  /**
   * Makes sure a tab exists and that EVERY header in `headers` is present in row 1.
   * Missing headers are appended to the right of whatever is already there; existing columns are
   * never moved, renamed or overwritten. Returns the full header row as it now stands.
   */
  async ensureTab(title: string, headers: readonly string[]): Promise<{ tab: TabInfo; headers: string[]; added: string[]; created: boolean }> {
    let tab = await this.findTab(title);
    let created = false;
    if (!tab) {
      await this.call('/:batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: Math.max(26, headers.length) } } } }] },
      });
      tab = await this.findTab(title, true);
      if (!tab) throw new Error(`Could not create tab ${title}`);
      created = true;
    }
    const current = (await this.getValues(`${q(title)}!1:1`))[0]?.map((c) => String(c ?? '').trim()) ?? [];
    const have = new Set(current.filter(Boolean));
    const missing = headers.filter((h) => !have.has(h));
    if (missing.length === 0) return { tab, headers: current, added: [], created };

    // Row 1 may have blank gaps; append after the last non-empty header.
    let lastIdx = current.length - 1;
    while (lastIdx >= 0 && !current[lastIdx]) lastIdx--;
    const startCol = lastIdx + 1;
    const needCols = startCol + missing.length;
    if (tab.columnCount < needCols) {
      await this.call('/:batchUpdate', {
        method: 'POST',
        body: { requests: [{ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { columnCount: needCols } }, fields: 'gridProperties.columnCount' } }] },
      });
      tab = (await this.findTab(title, true)) ?? tab;
    }
    await this.updateRanges([{ range: `${q(title)}!${colLetter(startCol)}1`, values: [missing] }], true);
    const merged = current.slice(0, startCol);
    while (merged.length < startCol) merged.push('');
    return { tab, headers: [...merged, ...missing], added: [...missing], created };
  }

  /* ---- values */

  async getValues(range: string, unformatted = false): Promise<string[][]> {
    const qs = `?majorDimension=ROWS${unformatted ? '&valueRenderOption=UNFORMATTED_VALUE' : ''}`;
    const r = await this.call<{ values?: unknown[][] }>(`/values/${encodeURIComponent(range)}${qs}`);
    return (r.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? '' : String(c))));
  }

  /** Reads the header row plus (at most) the last `tail` data rows. Row numbers are real sheet rows. */
  async readTail(title: string, tail = 400): Promise<{ headers: string[]; rows: { rowNumber: number; cells: string[] }[]; lastRow: number }> {
    const colA = await this.getValues(`${q(title)}!A:A`);
    const lastRow = colA.length;
    const headers = (await this.getValues(`${q(title)}!1:1`))[0] ?? [];
    if (lastRow <= 1) return { headers, rows: [], lastRow };
    const start = Math.max(2, lastRow - tail + 1);
    const data = await this.getValues(`${q(title)}!A${start}:${colLetter(Math.max(headers.length, 1) - 1)}${lastRow}`);
    return { headers, rows: data.map((cells, i) => ({ rowNumber: start + i, cells })), lastRow };
  }

  /** Reads everything below the header (used by backfill, where we need whole months). */
  async readAll(title: string): Promise<{ headers: string[]; rows: { rowNumber: number; cells: string[] }[] }> {
    const all = await this.getValues(`${q(title)}!A:ZZ`);
    const headers = (all[0] ?? []).map((c) => String(c).trim());
    return { headers, rows: all.slice(1).map((cells, i) => ({ rowNumber: i + 2, cells })) };
  }

  async append(title: string, rows: Cell[][], raw = false): Promise<void> {
    if (rows.length === 0) return;
    await this.call(
      `/values/${encodeURIComponent(`${q(title)}!A1`)}:append?valueInputOption=${raw ? 'RAW' : 'USER_ENTERED'}&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { majorDimension: 'ROWS', values: rows } });
  }

  async updateRanges(updates: { range: string; values: Cell[][] }[], raw = false): Promise<void> {
    if (updates.length === 0) return;
    await this.call('/values:batchUpdate', {
      method: 'POST',
      body: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED', data: updates.map((u) => ({ range: u.range, majorDimension: 'ROWS', values: u.values })) },
    });
  }
}

/* ---- singleton for the real spreadsheet --------------------------------------------------- */

let singleton: SheetsClient | null = null;

export function getSheetsClient(): SheetsClient {
  if (singleton) return singleton;
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID is not set');
  const jwt = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  singleton = new SheetsClient({
    spreadsheetId: id,
    getToken: async () => {
      const t = await jwt.getAccessToken();
      if (!t.token) throw new Error('Could not get a Google access token');
      return t.token;
    },
  });
  return singleton;
}

/** Turns a raw header row + cells into an object, so code never depends on column positions. */
export function rowToObject(headers: string[], cells: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  headers.forEach((h, i) => { if (h) o[h] = cells[i] ?? ''; });
  return o;
}

/** Builds a row in the sheet's own column order from an object. Unknown columns are left blank. */
export function objectToRow(headers: string[], obj: Record<string, Cell | undefined>): Cell[] {
  return headers.map((h) => { const v = h ? obj[h] : undefined; return v === undefined || v === null ? '' : v; });
}
