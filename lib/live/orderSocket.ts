/**
 * Browser client for Dhan's order-update WebSocket. It only speeds things up: the REST poll in the
 * live session is the source of truth, so if this socket can't connect (Dhan may refuse browser
 * origins) nothing is lost, you just see changes a few seconds later.
 */

export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';

export interface SocketOptions {
  token: string;
  clientId: string;
  onState: (s: SocketState, detail?: string) => void;
  onMessage: (msg: unknown) => void;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  maxFailures?: number;                       // consecutive failed attempts before giving up
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

export const ORDER_WS_URL = 'wss://api-order-update.dhan.co';

export function loginMessage(clientId: string, token: string) {
  return JSON.stringify({ LoginReq: { MsgCode: 42, ClientId: clientId, Token: token }, UserType: 'SELF' });
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function openOrderSocket(o: SocketOptions): { close: () => void } {
  const WS = o.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  const st = o.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const ct = o.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const max = o.maxFailures ?? 5;
  let ws: WebSocket | null = null;
  let stopped = false;
  let failures = 0;
  let timer: unknown = null;

  if (!WS) { o.onState('failed', 'WebSocket is not available in this browser'); return { close() {} }; }

  const connect = () => {
    if (stopped) return;
    o.onState(failures === 0 ? 'connecting' : 'reconnecting');
    let opened = false;
    try { ws = new WS(o.url ?? ORDER_WS_URL); } catch (e) { fail((e as Error).message); return; }
    ws.onopen = () => {
      opened = true;
      try { ws?.send(loginMessage(o.clientId, o.token)); } catch { /* handled by close */ }
      failures = 0;
      o.onState('open');
    };
    ws.onmessage = (ev: MessageEvent) => {
      try { const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : null; if (d) o.onMessage(d); } catch { /* ignore non-JSON frames */ }
    };
    ws.onerror = () => { /* followed by onclose */ };
    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      if (opened) failures = 0;
      fail(opened ? 'connection dropped' : 'could not connect');
    };
  };

  const fail = (why: string) => {
    if (stopped) return;
    failures += 1;
    if (failures >= max) { o.onState('failed', `${why}; gave up after ${failures} tries (polling continues)`); return; }
    o.onState('reconnecting', why);
    timer = st(connect, backoffMs(failures));
  };

  connect();
  return {
    close() {
      stopped = true;
      if (timer) ct(timer);
      try { ws?.close(); } catch { /* ignore */ }
      o.onState('closed');
    },
  };
}
