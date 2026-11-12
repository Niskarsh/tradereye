import { localParts } from './data';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtPrice(v: number, precision = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

/** Indian-style short numbers: 12.3K, 4.56L, 1.2Cr */
export function fmtVolume(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '—';
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

/** A value of an indicator (unknown size): a sensible number of decimals. */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e5) return fmtVolume(v);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

export function fmtTime(t: number, tz: number, intraday: boolean): string {
  const p = localParts(t, tz);
  const d = `${DOW[p.wd]} ${p.d} ${MON[p.mo]} '${String(p.y).slice(2)}`;
  return intraday ? `${d}  ${p2(Math.floor(p.min / 60))}:${p2(p.min % 60)}` : d;
}

/** Time-axis label for a tick of the given weight (see Chart.timeTicks). */
export function axisLabel(t: number, tz: number, weight: number, intraday = true): string {
  const p = localParts(t, tz);
  if (weight >= 5) return String(p.y);
  if (weight >= 4) return MON[p.mo];
  if (!intraday) return String(p.d);
  if (weight >= 3) return `${p.d} ${MON[p.mo]}`;
  return `${p2(Math.floor(p.min / 60))}:${p2(p.min % 60)}`;
}

export function fmtCountdown(sec: number): string {
  if (sec < 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}
