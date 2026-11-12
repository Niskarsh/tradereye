'use client';

/**
 * fetch that always settles: a phone can freeze a page (switching apps, locking the screen) and leave a request
 * hanging forever. After `ms` it is aborted and throws, so whoever waits on it can try again instead of waiting forever.
 */
export async function fetchT(url: string, init: RequestInit = {}, ms = 30_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`no answer in ${Math.round(ms / 1000)} s`);
    throw e;
  } finally { clearTimeout(timer); }
}
