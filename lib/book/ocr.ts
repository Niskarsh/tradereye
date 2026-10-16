/**
 * Screener screenshots -> NSE symbols with Gemini (free tier), so Claude credits are not spent on reading text.
 * GEMINI_API_KEY in Vercel; GEMINI_MODEL optional (else the newest Flash-Lite model the key can use).
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
let modelCache: string | null = null;

async function pickModel(key: string, f: typeof fetch): Promise<string> {
  const fixed = process.env.GEMINI_MODEL?.trim();
  if (fixed) return fixed.replace(/^models\//, '');
  if (modelCache) return modelCache;
  const r = await f(`${API}/models?key=${encodeURIComponent(key)}&pageSize=200`);
  const j = await r.json().catch(() => ({}));
  const names: string[] = (j.models ?? [])
    .filter((m: { name?: string; supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m: { name: string }) => m.name.replace(/^models\//, ''));
  const ver = (n: string) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const stable = (n: string) => !/preview|exp/.test(n);
  const pick = (re: RegExp) => names.filter((n) => re.test(n)).sort((a, b) => Number(stable(b)) - Number(stable(a)) || ver(b) - ver(a))[0];
  modelCache = pick(/flash-lite/) ?? pick(/flash/) ?? 'gemini-flash-lite-latest';
  return modelCache;
}

/** Candidate tickers from one or more screenshots (data URLs). Upper-case, de-duplicated, not yet validated. */
export async function symbolsFromImages(images: string[], key: string, f: typeof fetch = fetch): Promise<{ symbols: string[]; model: string }> {
  const model = await pickModel(key, f);
  const parts: unknown[] = [{ text: 'These are screenshots of a stock screener for the Indian NSE market. List every stock ticker symbol you can see (the trading symbol, e.g. TARIL, HINDPETRO, ANGELONE; not the company name). Return JSON only: {"symbols": ["..."]}. No other text.' }];
  for (const img of images) {
    const m = img.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const r = await f(`${API}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ? `Gemini: ${j.error.message}` : `Gemini HTTP ${r.status}`);
  const text: string = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  return { symbols: cleanSymbols(text), model };
}

/** Tickers out of Gemini's reply (JSON, or loose text as a fallback), upper-case and unique. */
export function cleanSymbols(text: string): string[] {
  let list: unknown[] = [];
  try { const o = JSON.parse(text); list = Array.isArray(o) ? o : Array.isArray(o?.symbols) ? o.symbols : []; }
  catch { list = text.split(/[\s,;"'\[\]{}:]+/); }
  return [...new Set(list.map((s) => String(s).trim().toUpperCase().replace(/^NSE:/, '').replace(/[^A-Z0-9&-]/g, '')).filter((s) => /^[A-Z][A-Z0-9&-]{1,19}$/.test(s) && s !== 'SYMBOLS'))];
}
