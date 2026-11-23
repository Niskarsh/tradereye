import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { DispatchError, dispatchWorkflow } from '@/lib/setups/github';
import { getJson, putJson } from '@/lib/setups/store';
import type { ShortSpec } from '@/lib/shorts/spec';
import { MAX_SPEECH_S } from '@/lib/shorts/voice';
import { setStatus, specKey, statusOf, store, validId } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RENDER_WORKFLOW = 'shorts-render.yml';

/**
 * POST { id, voice: { start, end } | null } -> starts the render of a my-bot's-trade short that was waiting for his line.
 * voice = where the speech sits in the uploaded take (seconds, from the browser's checks); null = render without voice.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({})) as { id?: string; voice?: { start?: number; end?: number } | null };
    const id = String(b.id ?? '');
    if (!validId(id)) return bad('Unknown short.');
    if ((await statusOf(id)).state !== 'voice') return bad('This short is not waiting for its voice.');
    const spec = await getJson<ShortSpec>(store, specKey(id));
    if (!spec || spec.content.kind !== 'bot') return bad('Only a "My bot\'s trade" short takes a voice.');
    if (b.voice) {
      const start = Number(b.voice.start), end = Number(b.voice.end);
      if (!(start >= 0 && end > start && end - start <= MAX_SPEECH_S + 0.5)) return bad('The take\'s timing is off: record it again.');
      spec.content.voice = { start, end };
    } else delete spec.content.voice;
    await putJson(store, specKey(id), spec);
    await setStatus(id, { state: 'queued', updatedAt: Date.now() });
    try { await dispatchWorkflow(RENDER_WORKFLOW, { short_id: id }, 'the render job'); }
    catch (e) {
      const msg = e instanceof DispatchError ? e.message : (e as Error).message;
      await setStatus(id, { state: 'failed', updatedAt: Date.now(), error: msg });
      return NextResponse.json({ error: 'DISPATCH_FAILED', message: msg }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}

const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
