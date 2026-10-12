export const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const tone = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-data-green' : 'text-data-red');
export const dur = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);
export const countdown = (ms: number) => {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
