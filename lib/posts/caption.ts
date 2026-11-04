import { jsonClaude, type ClaudeOptions } from '../copilot/claude';
import { capHashtags } from '../shorts/posts';
import { withDisclaimer } from '../shorts/disclaimer';
import { claudeOptions } from '../shorts/write';

/** The words of today's post, written by Claude only when the button is pressed. Real facts only, sent by the page. */

const SYSTEM = `You write the words for the daily P&L post of "Candles Before Cubicles", a software engineer's public log of his own NSE intraday trades, on Instagram and YouTube's Posts tab.
Use only the facts given. Never invent a number, a reason or a feeling.
A red day gets the same straight, unembarrassed treatment as a green one; this log's point is that it shows both.
Plain English, short lines, no hype, no emojis beyond one if it fits. Never use the words guaranteed, sure-shot, or tip. Do not tell anyone to buy or sell anything, do not say what a stock may do next, and do not present this as education. It is his own record.
Do not write a disclaimer: one is added automatically. Do not use anyone's personal name.
instagram: first line (under 125 characters) is the hook and states the day's real result. 2-5 short lines after it. One easy question viewers can answer in a comment. End with 3-5 relevant hashtags on their own line.
youtube: first line (under 100 characters) is the hook, because that is all a feed shows. 2-4 short lines after it. One easy question for the comments. At most 3 hashtags.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['instagram', 'youtube'],
  properties: { instagram: { type: 'string' }, youtube: { type: 'string' } },
};

export interface WrittenPost { instagram: string; youtube: string; costInr: number }

export async function writePost(facts: unknown, o: ClaudeOptions = claudeOptions()): Promise<WrittenPost> {
  const r = await jsonClaude(SYSTEM, `Today's facts as JSON:\n${JSON.stringify(facts).slice(0, 8000)}`, SCHEMA, o, 1200);
  const j = r.json as { instagram?: unknown; youtube?: unknown };
  if (typeof j.instagram !== 'string' || typeof j.youtube !== 'string') throw new Error(r.cutOff ? 'Claude\'s answer was cut short.' : 'Claude returned no usable text.');
  return { instagram: withDisclaimer(capHashtags(j.instagram), 'instagram'), youtube: withDisclaimer(j.youtube, 'youtube'), costInr: r.costInr };
}
