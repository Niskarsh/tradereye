/** The ticked images not yet up as a Story today, so a second press sends only what is missing. No server code here: the page uses it. */
export function storiesToSend(chosen: string[], state: { stories: { slides: string[] }[] }): string[] {
  return chosen.filter((n) => !state.stories.some((s) => s.slides[0] === `story-${n}`));
}

/** A short request that cannot hang: a connection that drops or goes silent is tried again; an answer from the server is final. */
export async function steady(step: string, url: string, body: unknown, timeoutMs: number, gapMs = 1500, fetchImpl: typeof fetch = fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), timeoutMs);
    try { return await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: stop.signal }); }
    catch {
      if (attempt >= 3) throw new Error(`${step}: the connection kept dropping.`);
      await new Promise((r) => setTimeout(r, gapMs * (attempt + 1)));
    } finally { clearTimeout(t); }
  }
}
