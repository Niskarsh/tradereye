import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { RUN_ID, claudeRulesKey, getJson, momentsKey, putJson, studyKey } from '@/lib/setups/store';
import { ClaudeError, jsonClaude } from '@/lib/copilot/claude';
import { settings } from '@/lib/copilot/settings';
import { RULES_SCHEMA, RULES_SYSTEM, buildRulesMessage, cleanRules, testRules, type ClaudeBatch } from '@/lib/study/claudeRules';
import { decodeMoments, gunzipBytes, type MomentsFile } from '@/lib/study/moments';
import type { Study } from '@/lib/study/analyze';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Claude thinks for a while, then every rule is tested on the saved entries

const store = { get: getChunk, put: putChunk };

/** GET ?run=<id> -> every batch of rules Claude wrote for that run, newest first. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const run = new URL(req.url).searchParams.get('run') ?? '';
    if (!RUN_ID.test(run)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing run.' }, { status: 400 });
    return NextResponse.json({ batches: (await getJson<ClaudeBatch[]>(store, claudeRulesKey(run))) ?? [] });
  } catch (e) { return errorResponse(e); }
}

/**
 * POST { run, refine?, focus? } -> Claude writes rules from YEAR 1 of the study; each is tested on year 1, year 2 and
 * both years on the saved entries; the batch is saved and returned. One Claude call per press.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const run = String(b?.run ?? '');
    const refine = b?.refine === true;
    const focus = typeof b?.focus === 'string' ? b.focus.slice(0, 600) : undefined;
    if (!RUN_ID.test(run)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing run.' }, { status: 400 });
    const study = await getJson<Study>(store, studyKey(run));
    if (!study) return NextResponse.json({ error: 'NOT_FOUND', message: 'That study is not saved.' }, { status: 404 });
    const [long, short] = await Promise.all([store.get(momentsKey(run, 1)), store.get(momentsKey(run, -1))]);
    if (!long || !short) return NextResponse.json({ error: 'NO_ENTRIES', message: 'This run did not save its entries, so new rules cannot be tested on it. Press Re-run on My Setups once.' }, { status: 409 });
    const batches = (await getJson<ClaudeBatch[]>(store, claudeRulesKey(run))) ?? [];

    const message = buildRulesMessage(study, { previous: refine ? batches[0] : undefined, focus });
    const s = settings();
    let reply;
    try { reply = await jsonClaude(RULES_SYSTEM, message, RULES_SCHEMA, { apiKey, model: s.model, usdInr: s.usdInr, timeoutMs: 240_000 }, 20_000); }
    catch (e) {
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
    const { rules, dropped } = cleanRules(reply.json);
    if (!rules.length) return NextResponse.json({ error: 'NO_RULES', message: reply.cutOff ? 'Claude ran out of room before finishing. Press again.' : 'Claude returned no usable rules. Press again.', costInr: reply.costInr }, { status: 502 });
    const files: Record<1 | -1, MomentsFile> = { 1: decodeMoments(await gunzipBytes(long)), [-1]: decodeMoments(await gunzipBytes(short)) } as Record<1 | -1, MomentsFile>;
    const batch: ClaudeBatch = {
      id: `${Date.now().toString(36)}`, at: Date.now(), model: reply.model, costInr: reply.costInr, refine, focus,
      note: String((reply.json as { note?: unknown }).note ?? ''), rules: testRules(rules, files, study.period.mid), dropped,
    };
    await putJson(store, claudeRulesKey(run), [batch, ...batches].slice(0, 20));
    return NextResponse.json({ batch });
  } catch (e) { return errorResponse(e); }
}
