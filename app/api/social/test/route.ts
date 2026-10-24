import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { liveInstagram, liveYouTube } from '@/lib/social/connections';
import { containerStatus, createReelContainer, waitForContainer } from '@/lib/social/instagram';
import { uploadVideo } from '@/lib/social/youtube';
import { appBase } from '@/lib/social/oauth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SAMPLE = '/social/sample-short.mp4';

/**
 * POST { platform } -> proves the pipe works without posting anything public:
 *  - youtube: uploads the sample short as PRIVATE (only you can see it; delete it in YouTube Studio afterwards)
 *  - instagram: sends the sample to Instagram and waits until Meta has processed it, but does NOT publish
 *    (Reels cannot be private, so the last step, publishing, is left for real posts)
 */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { platform?: string; id?: string };
  const { platform } = body;
  const sampleUrl = `${appBase(req)}${SAMPLE}`;
  try {
    if (platform === 'youtube') {
      const { accessToken } = await liveYouTube();
      const r = await fetch(sampleUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Could not read the sample video (HTTP ${r.status}).`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const v = await uploadVideo(accessToken, bytes, {
        title: 'tradereye test upload (private)', description: 'Pipe test from tradereye. Safe to delete.', privacy: 'private',
      });
      return NextResponse.json({ ok: true, message: 'Uploaded as private. Only you can see it; delete it in YouTube Studio when done.', url: v.url, id: v.id });
    }
    if (platform === 'instagram') {
      const { conn } = await liveInstagram();
      if (!conn) throw new Error('Instagram is not connected yet.');
      const containerId = await createReelContainer({ accessToken: conn.accessToken, userId: conn.userId, videoUrl: sampleUrl, caption: 'tradereye test (not published)' });
      const s = await waitForContainer(conn.accessToken, containerId);
      if (s.code === 'FINISHED') return NextResponse.json({ ok: true, message: 'Instagram received and processed the video. Nothing was published; the test upload expires on its own within 24 hours.', id: containerId });
      // still processing is NOT a pass: only FINISHED proves Meta accepted the format. The page offers "Check status".
      if (s.code === 'IN_PROGRESS') return NextResponse.json({ ok: false, pending: true, message: 'Instagram is still processing the video, so the format isn\'t confirmed yet. Use Check status in a minute.', id: containerId }, { status: 202 });
      throw new Error(`Instagram could not process the video (${s.code}${s.detail ? `: ${s.detail}` : ''}).`);
    }
    if (platform === 'instagram-status') {
      // asks Meta again about an earlier test upload (the id the test returned)
      const id = String((body as { id?: unknown }).id ?? '');
      if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'id must be the test upload id' }, { status: 400 });
      const { conn } = await liveInstagram();
      if (!conn) throw new Error('Instagram is not connected yet.');
      const s = await containerStatus(conn.accessToken, id);
      if (s.code === 'FINISHED') return NextResponse.json({ ok: true, message: 'Instagram processed the video: format confirmed. Nothing was published.', id });
      if (s.code === 'IN_PROGRESS') return NextResponse.json({ ok: false, pending: true, message: 'Still processing. Check again in a minute.', id }, { status: 202 });
      throw new Error(`Instagram could not process the video (${s.code}${s.detail ? `: ${s.detail}` : ''}).`);
    }
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'platform must be youtube or instagram' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: 'TEST_FAILED', message: (e as Error).message }, { status: 502 });
  }
}
