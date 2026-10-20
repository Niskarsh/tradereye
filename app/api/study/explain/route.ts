import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { RUN_ID, getJson, studyKey } from '@/lib/setups/store';
import { ClaudeError, plainClaude } from '@/lib/copilot/claude';
import { settings } from '@/lib/copilot/settings';
import { EXPLAIN_PARTS, EXPLAIN_SYSTEM, buildExplainMessage, type ExplainPart } from '@/lib/study/explain';
import type { Study } from '@/lib/study/analyze';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const store = { get: getChunk, put: putChunk };

/**
 * POST { run, part, combo?, item?, question? } -> Claude explains that part of the Reversal Study in plain words.
 * One Claude call per press (never automatic). The numbers come from the saved study on the server, not the page.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const run = String(b?.run ?? ''), part = String(b?.part ?? '') as ExplainPart;
    const combo = Number(b?.combo ?? 0);
    const item = typeof b?.item === 'number' || typeof b?.item === 'string' ? b.item : undefined;
    const question = typeof b?.question === 'string' ? b.question.slice(0, 1000) : undefined;
    if (!RUN_ID.test(run) || !EXPLAIN_PARTS.includes(part) || !(combo >= 0 && combo <= 3)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing run or part.' }, { status: 400 });
    const study = await getJson<Study>(store, studyKey(run));
    if (!study) return NextResponse.json({ error: 'NOT_FOUND', message: 'That study is not saved.' }, { status: 404 });
    let message: string;
    try { message = buildExplainMessage(study, part, combo, item, question); }
    catch (e) { return NextResponse.json({ error: 'BAD_REQUEST', message: (e as Error).message }, { status: 400 }); }
    const s = settings();
    try {
      const r = await plainClaude(EXPLAIN_SYSTEM, message, { apiKey, model: s.model, usdInr: s.usdInr }, 1400);
      return NextResponse.json({ text: r.text, costInr: r.costInr, model: r.model });
    } catch (e) {
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
  } catch (e) { return errorResponse(e); }
}
