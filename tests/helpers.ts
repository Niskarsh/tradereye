/* eslint-disable @typescript-eslint/no-explicit-any */
import { SheetsClient } from '../lib/sheetsApi';

/** In-memory imitation of the slice of the Google Sheets REST API that SheetsClient uses. */
export class FakeSheets {
  tabs = new Map<string, { id: number; rows: string[][]; cols: number }>();
  calls: string[] = [];
  private nextId = 1;

  addTab(title: string, rows: (string | number)[][] = []) {
    this.tabs.set(title, { id: this.nextId++, rows: rows.map((r) => r.map(String)), cols: 26 });
  }
  rows(title: string) { return this.tabs.get(title)!.rows; }
  table(title: string): Record<string, string>[] {
    const [h, ...r] = this.rows(title);
    return r.map((c) => Object.fromEntries(h.map((k, i) => [k, c[i] ?? ''])));
  }

  private colIdx(s: string) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
  private parseRange(range: string) {
    const m = range.match(/^'((?:[^']|'')+)'!(.+)$/)!;
    const title = m[1].replace(/''/g, "'");
    const a = m[2];
    let r1 = 0, r2 = Infinity, c1 = 0, c2 = Infinity, mm;
    if ((mm = a.match(/^(\d+):(\d+)$/))) { r1 = +mm[1] - 1; r2 = +mm[2] - 1; }
    else if ((mm = a.match(/^([A-Z]+):([A-Z]+)$/))) { c1 = this.colIdx(mm[1]); c2 = this.colIdx(mm[2]); }
    else if ((mm = a.match(/^([A-Z]+)(\d+):([A-Z]+)$/))) { c1 = this.colIdx(mm[1]); r1 = +mm[2] - 1; c2 = this.colIdx(mm[3]); }
    else if ((mm = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/))) { c1 = this.colIdx(mm[1]); r1 = +mm[2] - 1; c2 = this.colIdx(mm[3]); r2 = +mm[4] - 1; }
    else if ((mm = a.match(/^([A-Z]+)(\d+)$/))) { c1 = this.colIdx(mm[1]); r1 = +mm[2] - 1; c2 = c1; r2 = r1; }
    else throw new Error(`unsupported range ${range}`);
    return { title, r1, r2, c1, c2 };
  }

  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace(/^\/v4\/spreadsheets\/[^/]+/, ''));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push(`${method} ${path}`);
    const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });

    if (method === 'GET' && path === '') {
      return ok({ sheets: [...this.tabs].map(([title, t]) => ({ properties: { sheetId: t.id, title, gridProperties: { rowCount: 1000, columnCount: t.cols } } })) });
    }
    if (method === 'POST' && path === '/:batchUpdate') {
      for (const r of body.requests) {
        if (r.addSheet) this.addTab(r.addSheet.properties.title);
        if (r.updateSheetProperties) {
          const t = [...this.tabs.values()].find((x) => x.id === r.updateSheetProperties.properties.sheetId)!;
          t.cols = r.updateSheetProperties.properties.gridProperties.columnCount;
        }
      }
      return ok({});
    }
    const readRange = (range: string): string[][] | null => {
      const { title, r1, r2, c1, c2 } = this.parseRange(range);
      const t = this.tabs.get(title);
      if (!t) return null;
      const out = t.rows.slice(r1, r2 === Infinity ? undefined : r2 + 1).map((r) => r.slice(c1, c2 === Infinity ? undefined : c2 + 1));
      while (out.length && out[out.length - 1].every((c) => c === '')) out.pop();
      return out;
    };
    if (method === 'GET' && path === '/values:batchGet') {
      const valueRanges = [];
      for (const r of url.searchParams.getAll('ranges')) {
        const v = readRange(r);
        if (!v) return new Response('{"error":"no such sheet"}', { status: 400 });
        valueRanges.push({ values: v });
      }
      return ok({ valueRanges });
    }
    if (method === 'GET' && path.startsWith('/values/')) {
      const out = readRange(path.slice('/values/'.length));
      if (!out) return new Response('{"error":"no such sheet"}', { status: 400 });
      return ok({ values: out });
    }
    if (method === 'POST' && path.endsWith(':clear')) {
      const { title, r1 } = this.parseRange(decodeURIComponent(path.slice('/values/'.length).replace(/:clear$/, '')));
      const t = this.tabs.get(title)!;
      t.rows.length = Math.min(t.rows.length, r1);
      return ok({});
    }
    if (method === 'POST' && path.includes(':append')) {
      const title = this.parseRange(path.slice('/values/'.length).replace(':append', '')).title;
      const t = this.tabs.get(title)!;
      for (const row of body.values) t.rows.push(row.map((c: unknown) => (c === null || c === undefined ? '' : String(c))));
      return ok({});
    }
    if (method === 'POST' && path === '/values:batchUpdate') {
      for (const d of body.data) {
        const { title, r1, c1 } = this.parseRange(d.range);
        const t = this.tabs.get(title)!;
        d.values.forEach((row: unknown[], i: number) => {
          while (t.rows.length <= r1 + i) t.rows.push([]);
          row.forEach((v, j) => { const r = t.rows[r1 + i]; while (r.length <= c1 + j) r.push(''); r[c1 + j] = v === null || v === undefined ? '' : String(v); });
        });
      }
      return ok({});
    }
    return new Response(`unhandled ${method} ${path}`, { status: 500 });
  };

  client() {
    return new SheetsClient({ spreadsheetId: 'SHEET', getToken: async () => 'tok', fetchImpl: this.fetch, sleep: async () => {} });
  }
}

export const IST = (date: string, time: string) => Date.parse(`${date}T${time}+05:30`);
