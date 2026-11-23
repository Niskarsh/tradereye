/**
 * Checks on his recorded line, run in the browser on the decoded audio (no upload, no API cost). They catch the takes
 * that would hurt the short: words wrong, too long for the opening, too quiet, distorted, rushed or dragged, or flat
 * (monotone). They do NOT judge emotion: no check can tell meant from acted. The delivery note + his own ear do that.
 * Pure functions on raw samples, so they are tested without a browser.
 */

export interface VoiceCheck { key: 'words' | 'length' | 'loud' | 'clip' | 'pace' | 'flat'; ok: boolean; skipped?: boolean; msg: string }
export interface VoiceResult { ok: boolean; start: number; end: number; checks: VoiceCheck[]; pitchSpread?: number }

/** The opening has room for this much speech (seconds). */
export const MAX_SPEECH_S = 4.0;
export const MIN_SPEECH_S = 0.8;
/** Loudest 20 ms of speech must reach this (dBFS): quieter and the phone speaker loses it. */
export const MIN_PEAK_DB = -26;
/** Share of samples at full scale above which the take sounds distorted. */
export const MAX_CLIP_SHARE = 0.002;
/** Spread of the voice's pitch (standard deviation, semitones). Natural conversational speech is usually 2-4;
 * a read-out monotone sits near 1. Below this the take is called flat. */
export const MIN_PITCH_SPREAD = 1.5;
/** Share of the line's words the transcript must contain. */
export const MIN_WORD_MATCH = 0.7;

const FRAME_S = 0.02;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

/** RMS per 20 ms frame. */
export function frameRms(x: Float32Array, sr: number): number[] {
  const n = Math.max(1, Math.round(sr * FRAME_S)), out: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j] * x[j];
    out.push(Math.sqrt(s / n));
  }
  return out;
}

/** Where the speech is: frames louder than -45 dBFS and within 30 dB of the loudest, padded 0.1 s / 0.15 s. */
export function speechBounds(x: Float32Array, sr: number): { start: number; end: number; peakDb: number } | null {
  const r = frameRms(x, sr);
  if (!r.length) return null;
  const peak = Math.max(...r), gate = Math.max(db(peak) - 30, -45);
  const loud = r.map((v) => db(v) >= gate);
  const first = loud.indexOf(true), last = loud.lastIndexOf(true);
  if (first < 0 || db(peak) < -50) return null;
  const dur = x.length / sr;
  return { start: Math.max(0, first * FRAME_S - 0.1), end: Math.min(dur, (last + 1) * FRAME_S + 0.15), peakDb: db(peak) };
}

export function clipShare(x: Float32Array): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 0.98) n++;
  return x.length ? n / x.length : 0;
}

/** Pitch of one frame by autocorrelation (75-400 Hz), or null when the frame is not clearly voiced. */
export function framePitch(x: Float32Array, sr: number): number | null {
  const minLag = Math.floor(sr / 400), maxLag = Math.min(Math.floor(sr / 75), x.length - 1);
  let e0 = 0;
  for (let i = 0; i < x.length; i++) e0 += x[i] * x[i];
  if (e0 <= 0 || maxLag <= minLag) return null;
  let best = 0, lag = 0;
  for (let k = minLag; k <= maxLag; k++) {
    let s = 0, e1 = 0;
    for (let i = 0; i + k < x.length; i++) { s += x[i] * x[i + k]; e1 += x[i + k] * x[i + k]; }
    const c = s / Math.sqrt(e0 * e1 || 1);
    if (c > best) { best = c; lag = k; }
  }
  return best >= 0.6 && lag ? sr / lag : null;
}

/** Standard deviation of the voiced frames' pitch, in semitones (null with fewer than 8 voiced frames). */
export function pitchSpread(x: Float32Array, sr: number, start: number, end: number): number | null {
  const n = Math.round(sr * 0.04), hop = Math.round(sr * 0.02);
  const r = frameRms(x.subarray(Math.floor(start * sr), Math.floor(end * sr)), sr);
  const peak = Math.max(0, ...r);
  const st: number[] = [];
  for (let i = Math.floor(start * sr); i + n <= Math.min(x.length, end * sr); i += hop) {
    const f = x.subarray(i, i + n);
    let s = 0;
    for (let j = 0; j < f.length; j++) s += f[j] * f[j];
    if (Math.sqrt(s / f.length) < peak * 0.15) continue; // quiet frames: breath, room noise
    const hz = framePitch(f, sr);
    if (hz) st.push(12 * Math.log2(hz / 100));
  }
  if (st.length < 8) return null;
  // autocorrelation sometimes jumps an octave (12 semitones): such frames would make a flat take look lively, so drop
  // anything more than 7 semitones from the median before measuring the spread
  const med = [...st].sort((a, b) => a - b)[st.length >> 1];
  const keep = st.filter((v) => Math.abs(v - med) <= 7);
  if (keep.length < 8) return null;
  const mean = keep.reduce((a, b) => a + b, 0) / keep.length;
  return Math.sqrt(keep.reduce((a, b) => a + (b - mean) ** 2, 0) / keep.length);
}

const NUM_WORDS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
/** Words for comparing: lowercase, no punctuation, "₹420" / "rs 420" / "420 rupees" all become "420". */
export function wordsOf(s: string): string[] {
  return s.toLowerCase().replace(/₹|\brs\.?\b|\brupees?\b|\binr\b/g, ' ').replace(/(\d),(\d)/g, '$1$2').replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'/g, '').split(/\s+/).filter(Boolean).map((w) => NUM_WORDS[w] ?? w);
}

/** Share of the line's words found in the transcript (order not required; a number counts once). */
export function wordMatch(line: string, transcript: string): number {
  const want = wordsOf(line), got = wordsOf(transcript);
  if (!want.length) return 1;
  const pool = [...got];
  let hit = 0;
  for (const w of want) { const i = pool.indexOf(w); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return hit / want.length;
}

/** All checks on one take. `transcript` null = the browser has no speech recognition (the word check is skipped). */
export function checkTake(x: Float32Array, sr: number, line: string, transcript: string | null): VoiceResult {
  const b = speechBounds(x, sr);
  if (!b) return { ok: false, start: 0, end: 0, checks: [{ key: 'loud', ok: false, msg: 'No speech heard. Check the mic and try again.' }] };
  const dur = b.end - b.start, words = wordsOf(line).length;
  const checks: VoiceCheck[] = [];
  if (transcript === null) checks.push({ key: 'words', ok: true, skipped: true, msg: 'Word check needs Chrome (skipped).' });
  else {
    const m = wordMatch(line, transcript);
    checks.push({ key: 'words', ok: m >= MIN_WORD_MATCH, msg: m >= MIN_WORD_MATCH ? 'Words match the line.' : `Heard "${transcript.trim() || 'nothing'}". Say the line as written.` });
  }
  checks.push(dur > MAX_SPEECH_S ? { key: 'length', ok: false, msg: `${dur.toFixed(1)} s is too long: the opening has ${MAX_SPEECH_S} s. Say it tighter.` }
    : dur < MIN_SPEECH_S ? { key: 'length', ok: false, msg: 'Too short: was the whole line in it?' }
    : { key: 'length', ok: true, msg: `${dur.toFixed(1)} s: fits the opening.` });
  checks.push(b.peakDb < MIN_PEAK_DB ? { key: 'loud', ok: false, msg: 'Too quiet: hold the phone closer or speak up.' } : { key: 'loud', ok: true, msg: 'Loud enough.' });
  const cs = clipShare(x.subarray(Math.floor(b.start * sr), Math.floor(b.end * sr)));
  checks.push(cs > MAX_CLIP_SHARE ? { key: 'clip', ok: false, msg: 'Distorted: too close to the mic or too loud. Back off a little.' } : { key: 'clip', ok: true, msg: 'Clean, no distortion.' });
  const wps = words / Math.max(dur, 0.1);
  checks.push(wps > 4.5 ? { key: 'pace', ok: false, msg: 'Rushed: slow down a touch.' } : wps < 1.3 ? { key: 'pace', ok: false, msg: 'Dragging: say it as one thought.' } : { key: 'pace', ok: true, msg: 'Pace is natural.' });
  const spread = pitchSpread(x, sr, b.start, b.end);
  if (spread === null) checks.push({ key: 'flat', ok: true, skipped: true, msg: 'Not enough voiced sound to judge flatness.' });
  else checks.push(spread < MIN_PITCH_SPREAD
    ? { key: 'flat', ok: false, msg: 'Sounds flat, like reading. Say it the way you would tell a friend: let your voice rise and fall.' }
    : { key: 'flat', ok: true, msg: 'Your voice moves: not monotone.' });
  return { ok: checks.every((c) => c.ok), start: Math.round(b.start * 100) / 100, end: Math.round(b.end * 100) / 100, checks, pitchSpread: spread ?? undefined };
}
