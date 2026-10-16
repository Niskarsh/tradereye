import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { askClaude, checkScenarios, ClaudeError } from '@/lib/copilot/claude';
import { askedToday, FACTS_TTL_MS, readChecks, recall, updateCheck } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Ask Claude: the ONLY route that calls the Claude API. Body: { checkId, date }. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const checkId = String(b?.checkId ?? ''), date = String(b?.date ?? '');
    if (!checkId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing check.' }, { status: 400 });
    const s = settings();
    const sheets = getSheetsClient();
    const { title, headers, rows } = await readChecks(sheets, date);
    const hit = rows.find((r) => r.o.CheckId === checkId);
    if (!hit) return NextResponse.json({ error: 'NOT_FOUND', message: 'That check is not in the sheet. Tap the symbol again.' }, { status: 404 });
    if (hit.o.Status === 'ASKED') return NextResponse.json({ error: 'ALREADY_ASKED', message: 'Already asked. Tap the symbol again for fresh facts.' }, { status: 409 });
    const created = Number(hit.o.CreatedAt);
    if (Number.isFinite(created) && Date.now() - created > FACTS_TTL_MS) {
      return NextResponse.json({ error: 'STALE', message: 'These facts are over 15 minutes old. Tap the symbol again.' }, { status: 409 });
    }
    if (askedToday(rows, date) >= s.dailyLimit) {
      return NextResponse.json({ error: 'DAILY_LIMIT', message: `Daily limit of ${s.dailyLimit} asks reached. The Facts card still works.` }, { status: 429 });
    }
    const payload = recall(checkId)?.payload ?? hit.o.PayloadJson;
    if (!payload) return NextResponse.json({ error: 'NO_PAYLOAD', message: 'Tap the symbol again.' }, { status: 409 });

    const found = { title, rowNumber: hit.rowNumber, headers, o: hit.o };
    try {
      const raw = await askClaude(payload, { apiKey, model: s.model, usdInr: s.usdInr, thinking: s.thinking });
      const r = { ...raw, scenarios: checkScenarios(raw.scenarios, payload) };
      const firstSetup = r.scenarios.find((x) => x.kind === 'SETUP');
      await updateCheck(sheets, found, {
        Status: 'ASKED', Model: r.model, Verdict: r.verdict, Line1: r.lines[0] ?? '', Line2: r.lines[1] ?? '', Line3: r.lines[2] ?? '',
        Watch: r.watch, AltDirection: firstSetup?.direction ?? '', AltSetup: firstSetup?.setup ?? '', AltStop: firstSetup?.stop ?? '', AltReason: firstSetup?.why ?? '',
        Scenarios: r.scenarios.map((x) => `${x.kind}${x.setup ? ` ${x.setup} ${x.direction}` : ' stand aside'}${x.stop ? ` stop ${x.stop}` : ''}${x.target ? ` target ${x.target}` : ''}: ${x.why}${x.trigger ? ` | ${x.trigger}` : ''}`).join(' || ').slice(0, 1500),
        InTokens: r.inTokens, OutTokens: r.outTokens, CostInr: r.costInr, LatencyMs: r.latencyMs, Error: '',
      });
      return NextResponse.json({ ...r, asksLeft: Math.max(0, s.dailyLimit - askedToday(rows, date) - 1) });
    } catch (e) {
      const msg = (e as Error).message;
      await updateCheck(sheets, found, { Status: 'ERROR', Error: msg.slice(0, 300) }).catch(() => {});
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: msg }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
