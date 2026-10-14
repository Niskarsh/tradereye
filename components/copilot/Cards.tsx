"use client";
import React from 'react';
import type { AltResp, CheckResp, MarketResp, ReadResp } from './useCopilot';

const fmt = (v: unknown, digits = 2): string => {
  if (v === undefined || v === null || v === '') return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(digits);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};
const signed = (v: number | undefined, digits = 2, unit = '') => (v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`);

const STATE_TEXT: Record<string, string> = {
  OPENING: 'Opening (first 5 min)', TRENDING_UP: 'Trending up', TRENDING_DOWN: 'Trending down',
  FADING_UP: 'Up, fading', FADING_DOWN: 'Down, fading', FLAT: 'Flat', FLIPPED: 'Flipped', UNKNOWN: 'No data',
};
const stateTone = (s: string) => (s.startsWith('TRENDING') ? 'text-data-green' : s === 'FLIPPED' ? 'text-data-red' : s.startsWith('FADING') ? 'text-brand-accent' : 'text-zinc-300');

export function MarketStrip({ m, err }: { m: MarketResp | null; err: string }) {
  if (!m) return <div className="rounded-2xl bg-brand-card p-4 text-xs text-zinc-500">{err || 'Loading market…'}</div>;
  const k = m.market;
  return (
    <div className="rounded-2xl bg-brand-card p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Nifty 500 {k.live ? '' : `· ${k.date} close`}</p>
          <p className={`text-xl font-black tracking-tight ${stateTone(k.state)}`}>{STATE_TEXT[k.state] ?? k.state}</p>
        </div>
        <div className="text-right font-mono text-xs text-zinc-400 leading-5">
          <div>first 5m {signed(k.first5, 2, '%')}</div>
          <div>now {signed(k.nowPct, 2, '%')} · 10m {signed(k.last10, 2, '%')}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>Trades today <b className="text-zinc-100">{m.you.TradesToday}</b></span>
        <span>P&amp;L <b className={m.you.PnlToday < 0 ? 'text-data-red' : 'text-data-green'}>₹{m.you.PnlToday.toFixed(0)}</b></span>
        <span>Open <b className="text-zinc-100">{m.you.OpenPositions}</b></span>
        {m.you.FirstTradeLost && <span className="rounded-md bg-data-red/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-data-red">First trade lost</span>}
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-zinc-900 last:border-0">
      <span className="text-xs text-zinc-400">{label}{hint && <span className="ml-1 text-[10px] text-zinc-600">{hint}</span>}</span>
      <span className="font-mono text-sm text-zinc-100 text-right">{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-brand-card px-4 py-3">
      <h3 className="mb-1 text-[9px] font-black uppercase tracking-widest text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

export function FactsCard({ c, onUseStop, onTryAlt }: { c: CheckResp; onUseStop?: (stop: number) => void; onTryAlt?: (a: AltResp) => void }) {
  const f = c.facts, b = c.behaviour, m = c.manage;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-lg font-black tracking-tight">{c.symbol} <span className="text-sm text-zinc-400">{c.direction} · {c.setup.toLowerCase()} · {c.mode === 'MANAGE' ? 'in trade' : 'entry'}</span></p>
        <p className="font-mono text-sm text-zinc-300">₹{c.price.toFixed(2)} <span className="text-[10px] text-zinc-600">{c.priceSource === 'LTP' ? 'live' : 'last candle'} {c.time.slice(0, 5)}</span></p>
      </div>
      {f.flags.length > 0 && (
        <ul className="rounded-2xl border border-data-red/40 bg-data-red/10 px-4 py-2 space-y-1">
          {f.flags.map((x) => <li key={x} className="text-xs font-bold text-data-red">{x}</li>)}
        </ul>
      )}
      {c.notes.length > 0 && <p className="text-[11px] text-zinc-500">{c.notes.join(' ')}</p>}

      {c.mode === 'ENTRY' && (
        <section className="rounded-2xl border border-zinc-800 bg-brand-card px-4 py-3 space-y-2">
          {f.SetupByMove && f.SetupByMove !== c.setup && (
            <p className="text-xs font-bold text-brand-accent">
              By today&apos;s move this {c.direction.toLowerCase()} is a {f.SetupByMove.toLowerCase()} trade, not a {c.setup.toLowerCase()}.
            </p>
          )}
          <p className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Fits the data now</p>
          {c.fitsNow.length === 0
            ? <p className="text-xs text-zinc-400">No setup has its core conditions met right now.{f.CoreMissing ? ` Yours is missing: ${f.CoreMissing}.` : ''}</p>
            : (
              <div className="flex flex-wrap gap-2">
                {c.fitsNow.map((x) => {
                  const mine = x.direction === c.direction && x.setup === c.setup;
                  return (
                    <button key={`${x.setup}${x.direction}`} disabled={mine || !onTryAlt}
                      onClick={() => onTryAlt?.({ direction: x.direction, setup: x.setup, stop: x.stop, reason: '' })}
                      className={`rounded-xl border px-3 py-2 text-left text-xs ${mine ? 'border-data-green/60 text-data-green' : 'border-zinc-700 text-zinc-200'}`}>
                      <span className="font-black">{x.setup.toLowerCase()} {x.direction.toLowerCase()}{mine ? ' (yours)' : ''}</span>
                      <span className="block font-mono text-[10px] text-zinc-400">{x.stop !== undefined ? `stop ${x.stop.toFixed(2)} · ` : ''}room {x.roomAtr ?? '–'} ATR</span>
                    </button>
                  );
                })}
              </div>
            )}
        </section>
      )}

      {m && (
        <Group title="In trade">
          <Row label="Avg entry / stop now" value={`${fmt(m.AvgEntry)} / ${fmt(m.CurrentStop)}`} />
          <Row label="Open R / best R" value={`${fmt(m.OpenR)} / ${fmt(m.BestR)}`} hint={m.GivebackR !== undefined ? `gave back ${fmt(m.GivebackR)}R` : undefined} />
          <Row label="Stop distance" value={`${fmt(m.StopDistAtr)} ATR`} />
          <Row label="Counter-volume" value={fmt(m.CounterVolRatio)} hint="against ÷ with" />
          <Row label="Climax against / failed extreme" value={`${m.ClimaxAgainst || '–'} / ${m.FailedExtreme || '–'}`} />
          <Row label="Nifty since entry" value={signed(m.NiftySinceEntryPct, 2, '%')} hint="+ = your way" />
          <Row label="Time in trade / stop moves" value={`${m.MinInTrade} min / ${fmt(m.StopMoves)}`} />
        </Group>
      )}

      <Group title="Market">
        <Row label="Nifty 500" value={STATE_TEXT[f.NiftyState] ?? f.NiftyState} />
        <Row label="First 5m / now / last 10m" value={`${signed(f.NiftyFirst5Pct, 2, '%')} / ${signed(f.NiftyNowPct, 2, '%')} / ${signed(f.NiftyLast10Pct, 2, '%')}`} />
      </Group>

      <Group title="Stock">
        <Row label="Rvol (TradingView)" value={fmt(f.RvolDay, 3)} />
        <Row label="  vs same time of day" value={`${fmt(f.RvolSameTime)}× · ${f.RvolBusy === 'YES' ? 'busier than usual' : f.RvolBusy === 'NO' ? 'not busy' : '–'}`} hint={f.RvolBasis?.startsWith('open') ? 'open: your 0.1 rule' : '1 = normal'} />
        <Row label="ATR 10m / 2x" value={`${fmt(f.Atr10m)} / ${fmt(f.Atr2)}`} />
        <Row label="200 EMA 5m · 10m · 1D" value={`${fmt(f.Ema200_5m)} · ${fmt(f.Ema200_10m)} · ${fmt(f.Ema200_1d)}`} />
        <Row label="  distance" value={`${fmt(f.Ema200_5mAtr)} · ${fmt(f.Ema200_10mAtr)} · ${fmt(f.Ema200_1dAtr)}`} hint="ATR, + above" />
        <Row label="Day high / low" value={`${fmt(f.DayHigh)} / ${fmt(f.DayLow)}`} />
        <Row label="First 10-min candle" value={f.OrHigh !== undefined ? `${fmt(f.OrLow)}–${fmt(f.OrHigh)} · price ${String(f.EntryVsOr).toLowerCase()}` : '–'} />
        <Row label="Prev day high / low" value={`${fmt(f.PdhDistAtr)} / ${fmt(f.PdlDistAtr)}`} hint="ATR" />
        <Row label="VWAP control" value={f.VwapSide ? `${f.VwapSide.toLowerCase()} · ${fmt(f.VwapHeldMin)} min` : '–'} />
        <Row label="vs Nifty (day / last 2 candles)" value={`${signed(f.RsVsNiftyPct, 2, '%')} / ${signed(f.Rs20mPct, 2, '%')}`} />
        <Row label="Extension from open" value={f.ExtAdrPct !== undefined ? `${signed(f.ExtAdrPct, 0, '%')} of ADR` : '–'} />
        <Row label="POC" value={f.PocPrice !== undefined ? `${fmt(f.PocPrice)} (${fmt(f.PocDistAtr)} ATR)` : '–'} hint="approx." />
        <Row label="Pullback no." value={fmt(f.PullbackNo)} hint="10m candles" />
        <Row label="Volume trend / push÷pull" hint="10m" value={`${f.VolTrend?.toLowerCase() ?? '–'} / ${fmt(f.PushVsPullVol)}`} />
        <Row label="Climax / failed break" value={`${f.Climax || '–'} / ${f.FailedBreak || '–'}`} />
      </Group>

      {c.mode === 'ENTRY' && (
        <Group title="Plan">
          <Row label="Stop distance" value={f.StopAssumed ? `${fmt(f.StopDist)} (2×ATR cap: type your stop)` : `${fmt(f.StopDist)} (${fmt(f.StopVsAtr2)}× of 2ATR)`} />
          <Row label="Size / risk" value={`${fmt(f.SizeQty)} sh / ₹${fmt(f.RiskInr, 0)}`} />
          <Row label="Next obstacle" value={f.RoomTo ?? '–'} />
        <Row label="  room" value={f.RoomAtr !== undefined ? `${fmt(f.RoomAtr)} ATR${f.RoomVsStop !== undefined ? ` · ${fmt(f.RoomVsStop)}× stop` : ''}` : '–'} />
          <Row label="Est. charges" value={f.EstChargesInr !== undefined ? `₹${fmt(f.EstChargesInr, 0)}` : '–'} />
          {f.StopIdea !== undefined && (
            <Row label="Stop from the 10m chart" hint="past the last 2 candles"
              value={<span>{fmt(f.StopIdea)} ({fmt(f.StopIdeaAtr)} ATR){onUseStop && <button onClick={() => onUseStop(f.StopIdea!)} className="ml-2 rounded-md border border-zinc-700 px-2 text-[10px] font-black uppercase text-zinc-300">Use</button>}</span>} />
          )}
        </Group>
      )}

      <Group title="You">
        <Row label="Trades / P&L today" value={`${b.TradesToday} / ₹${b.PnlToday.toFixed(0)}`} />
        <Row label="First trade lost / same symbol stopped" value={`${fmt(b.FirstTradeLost)} / ${fmt(b.SameSymbolStopped)}`} />
        <Row label="Minutes since last loss" value={fmt(b.MinSinceLoss)} />
        <Row label={`Your record: ${c.setup.toLowerCase()} ${c.direction.toLowerCase()}`} value={b.SetupTrades ? `${b.SetupTrades} tr · ${Math.round((b.SetupWinRate ?? 0) * 100)}% · ₹${fmt(b.SetupAvgPnl, 0)}` : 'not enough tagged trades'} />
      </Group>

      {f.missing.length > 0 && (
        <details className="text-[11px] text-zinc-600">
          <summary className="cursor-pointer">Not available ({f.missing.length})</summary>
          <ul className="mt-1 list-disc pl-5">{f.missing.map((x) => <li key={x}>{x}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  SUPPORTS: 'bg-data-green/15 border-data-green/50 text-data-green',
  HOLD_STEADY: 'bg-data-green/15 border-data-green/50 text-data-green',
  MIXED: 'bg-brand-accent/10 border-brand-accent/50 text-brand-accent',
  WEAKENING: 'bg-brand-accent/10 border-brand-accent/50 text-brand-accent',
  WARNING: 'bg-data-red/15 border-data-red/50 text-data-red',
  RAW: 'bg-brand-card border-zinc-700 text-zinc-200',
};
const LABEL: Record<string, string> = { SUPPORTS: 'Supports', HOLD_STEADY: 'Hold steady', MIXED: 'Mixed', WEAKENING: 'Weakening', WARNING: 'Warning', RAW: "Claude's reply" };

export function VerdictCard({ r, decision, onDecide, showDecision, onTryAlt }: { r: ReadResp; decision: string; onDecide: (d: 'TOOK' | 'SKIPPED') => void; showDecision: boolean; onTryAlt?: (a: AltResp) => void }) {
  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${TONE[r.verdict] ?? TONE.MIXED}`}>
      <p className="text-2xl font-black tracking-tight">{LABEL[r.verdict] ?? r.verdict}</p>
      <ol className="space-y-1.5 text-sm text-zinc-100">{r.lines.map((l, i) => <li key={i} className="leading-snug whitespace-pre-wrap">{l}</li>)}</ol>
      {r.watch && <p className="text-sm text-zinc-300"><span className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mr-2">Watch</span>{r.watch}</p>}
      <p className="text-[10px] text-zinc-500">{(r.latencyMs / 1000).toFixed(1)}s · ₹{r.costInr.toFixed(2)} · {r.model}</p>
      {r.alternative && (
        <div className="rounded-xl border border-zinc-700 bg-black/20 p-3 space-y-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Better fit</p>
          <p className="text-sm font-black text-zinc-100">
            {r.alternative.setup.toLowerCase()} {r.alternative.direction.toLowerCase()}
            {r.alternative.stop !== undefined && <span className="font-mono font-normal text-zinc-300"> · stop {r.alternative.stop.toFixed(2)}</span>}
          </p>
          {r.alternative.reason && <p className="text-xs text-zinc-300">{r.alternative.reason}</p>}
          {onTryAlt && (
            <button onClick={() => onTryAlt(r.alternative!)} className="h-9 w-full rounded-lg bg-zinc-100 text-black text-xs font-black uppercase tracking-wider">
              Set this up (then press Go)
            </button>
          )}
        </div>
      )}
      {showDecision && (
        <div className="flex gap-2 pt-1">
          {(['TOOK', 'SKIPPED'] as const).map((d) => (
            <button key={d} onClick={() => onDecide(d)} disabled={!!decision}
              className={`flex-1 h-10 rounded-xl text-xs font-black uppercase tracking-wider border ${decision === d ? 'bg-zinc-100 text-black border-zinc-100' : 'border-zinc-700 text-zinc-300'} disabled:opacity-60`}>
              {d === 'TOOK' ? 'Took it' : 'Skipped'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TodayChecks({ m }: { m: MarketResp | null }) {
  if (!m || !m.checks.length) return null;
  return (
    <details className="rounded-2xl bg-brand-card px-4 py-3">
      <summary className="cursor-pointer text-[9px] font-black uppercase tracking-widest text-zinc-500">Today&apos;s checks ({m.checks.length})</summary>
      <ul className="mt-2 divide-y divide-zinc-900 text-xs font-mono">
        {m.checks.map((c) => (
          <li key={c.checkId} className="flex justify-between gap-2 py-1.5">
            <span>{c.time?.slice(0, 5)} {c.symbol} {c.direction === 'SHORT' ? 'S' : 'L'} {c.mode === 'MANAGE' ? 're' : ''}</span>
            <span className="text-zinc-400">{LABEL[c.verdict] ?? (c.verdict || 'facts only')} {c.decision ? `· ${c.decision.toLowerCase()}` : ''} {c.tradeGroupId ? '· traded' : ''}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
