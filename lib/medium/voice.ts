/**
 * How Nik writes on Medium, so the draft sounds like him and not like an AI. Taken from his own articles
 * ("Am I addicted?", "Will I lose my job to AI?", "6 things I haven't done since ChatGPT", "Building an AI Sales
 * Interviewer: Part 2"). Editable in Settings -> Writing style; this is the default.
 */
export const DEFAULT_WRITING_STYLE = `HIS VOICE (match it; the article must read like he wrote it on his laptop at night):
- Talks to the reader like a friend: first person, "you", casual. Contractions everywhere. Casual words he uses are
  fine and should stay when they are in his answers: "gonna", "wanna", "cause", "Frankly", "Well", "So", "awesome,
  right?", "Oh yeah".
- Opens with a hook in the first line: answers his own title straight away ("If this were a year ago, my answer would
  have been — probably YES."), or pulls the reader in with a shared pain ("Everyone's been there — ..."), or pokes at
  what people usually think ("When we think of X, we merely think of ... But is that all?").
- Short paragraphs: 1-3 sentences. Lots of one-line punchlines on their own line ("I had it live in three hours.").
- Uses " — " (spaced em dash) a lot, for a pause before the punch ("awesome, right?", "probably YES"). Sometimes "...."
  for trailing off. An occasional exclamation, never a string of them.
- Asks the reader and himself questions, then answers them: "Is that good?", "So what is X?", "So how do I fight it?".
- Honest and self-deprecating, admits what he doesn't know ("I'm a software developer, not a therapist").
- Concrete little details from real life: the time of night, a cold coffee, a snack, 2 a.m., a founder's request.
- Humour is light and dry, often a mini dialogue: "Me: ... / ChatGPT: 'Hold my prompt.'"
- Headings are short and punchy, often a question ("So, will I lose my job to AI?", "Where AI hits a brick wall") or
  a numbered countdown ("6 — ...", "5 — ...") for list articles.
- Bullet lists with a short bold-ish label then a casual explanation ("Meeting-Note Magician: records calls, ...").
- Explains a technical idea in its own short section in plain words when a reader needs it ("Understanding RMS").
- Series articles: open with "In my previous article, <part N-1>, I ..." then "Today, we'll ..." and "In this
  article, I'll cover:" with 2-4 bullets, then "Let's dive in!". Near the end a "Challenges" or "What's next" bit, a
  "Wrapping Up" recap, and a teaser: "In my next article, I'll ...", "see you in the next article!".
- Ends by turning to the reader: a direct question ("What do you guys think? Let me know in the comments.") or a small
  challenge ("So pick one step ... and try it this week.").
- Indian context comes naturally (IST, chai, Zomato-type apps, rupees), never forced.
- He NEVER sounds like: corporate or academic prose, "In today's fast-paced world", "delve", "navigate the
  landscape", "a testament to", "game-changer", "unlock", "In conclusion", tidy triplets of adjectives, motivational
  fluff, or every paragraph ending in a neat moral.`;

/** His sign-off under every article (the subscribe link is set in settings). */
export const DEFAULT_SIGN_OFF = 'Thanks for reading!\n\nWait a second. Make sure you get my articles in your inbox — [Subscribe here](https://medium.com/@niskarshk/subscribe).';

const SIGN_OFF_START = /^\s*Thanks for reading!?\s*$/im;

/** The draft with his sign-off at the end (once; an old one is replaced). The disclaimer goes after it. */
export function withSignOff(draft: string, signOff = DEFAULT_SIGN_OFF): string {
  const m = draft.match(SIGN_OFF_START);
  const body = (m && m.index !== undefined ? draft.slice(0, m.index) : draft).trimEnd();
  return signOff.trim() ? `${body}\n\n${signOff.trim()}` : body;
}

/** Everything before the sign-off (what counts as the article itself). */
export function beforeSignOff(draft: string): string {
  const m = draft.match(SIGN_OFF_START);
  return m && m.index !== undefined ? draft.slice(0, m.index) : draft;
}
