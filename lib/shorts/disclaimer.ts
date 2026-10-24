/**
 * The risk disclaimer on every YouTube description and Instagram caption. Added in code (never left to Claude or to
 * an edit): it goes in above the closing hashtag line, once. Pure: used by the server and by tests.
 */

/** Text that marks the disclaimer as already present. */
export const DISCLAIMER_MARK = 'not a SEBI-registered';

export const YOUTUBE_DISCLAIMER = [
  'Disclaimer: I am not a SEBI-registered investment adviser or research analyst. This is my own trade, shared as a',
  'personal trading journal for information and entertainment only. It is not investment advice or a recommendation',
  'to buy, sell or hold any security. Trading carries a high risk of loss; past results do not guarantee future',
  'returns. Do your own research or consult a SEBI-registered adviser before trading.',
].join(' ');

export const INSTAGRAM_DISCLAIMER = 'Disclaimer: I am not a SEBI-registered adviser. My own trade, shared for information and entertainment only, not investment advice or a recommendation. Trading carries a high risk of loss; past results do not guarantee future returns.';

/** Mystery charts name the stock, so they say how old the prices are (SEBI's 3-month rule for price data). */
export const OLD_DATA_LINE = 'Prices shown are more than 3 months old.';

const HASHTAG_LINE = /^\s*(#[\p{L}\p{N}_]+[\s,]*)+$/u;

export function withDisclaimer(text: string, platform: 'youtube' | 'instagram', kind?: string): string {
  if (text.includes(DISCLAIMER_MARK)) return text;
  const lines = text.trimEnd().split('\n');
  const tail: string[] = [];
  while (lines.length && HASHTAG_LINE.test(lines[lines.length - 1])) tail.unshift(lines.pop()!);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const d = `${platform === 'youtube' ? YOUTUBE_DISCLAIMER : INSTAGRAM_DISCLAIMER}${kind === 'mystery' ? ` ${OLD_DATA_LINE}` : ''}`;
  return [...lines, ...(lines.length ? [''] : []), d, ...(tail.length ? ['', ...tail] : [])].join('\n');
}
