import { jsonClaude, type ClaudeOptions } from '../copilot/claude';
import { claudeOptions } from '../shorts/write';
import { asksForFact, cleanDraft, cleanTags, FORMATS, withDisclaimer, type Article, type Kit } from './article';
import { factsFor } from './material';
import { placeSectionMarkers, sectionsOf, toAiImages } from './prompts';

/**
 * The Medium page's two Claude calls, each only when he presses its button:
 *  1. Questions: 4-5 pointed questions about the period's real data, so the article is built from HIS experience.
 *  2. Draft: arranges HIS answers into the article (his sentences kept; only order, trims, short headings and
 *     one-line links added), plus the publish kit (title, subtitle, 5 tags, image captions).
 * Claude gets only factsFor(article) and his answers. The disclaimer is added by code; tickers of recent trades were
 * never given to Claude (they are "Stock A" ...), and the page blocks copying if one appears anyway.
 */

const AUDIENCE = `"Candles Before Cubicles": a software developer in India who day-trades stocks with his own money before
work, and builds his own trading app (tradereye) and a trading model. His Medium readers are curious people, most of
whom have NEVER traded: they must be able to follow every sentence without knowing any trading words.`;

const PLAIN = `Plain language, always:
- Write for someone who has never traded. Short sentences, everyday words.
- Every trading or data term gets a plain explanation the first time it appears, using the glossary in the data
  (e.g. "-0.20R a trade, meaning each trade lost a fifth of what it risked").
- Never use labels or codes from the data as if the reader knew them: no "Strategy A", no "iteration 7's F", no
  column names. Say what the thing is ("the version it kept", "a second version it compared against").
- No unexplained abbreviations or statistics jargon (t-stat, rank correlation, out-of-sample, walk-forward, ATR...).`;

const NEVER = `Never:
- invent experiences, feelings, events, numbers or quotes. Every number must be in the data or his answers.
- give investment advice: no buy / sell / hold calls, no "you should", no price targets, no predictions, no promises.
- reveal how his edge works: no model inputs or features, no thresholds, no entry / stop / target rules, even if hinted.
- write a disclaimer (it is added automatically).`;

export const QUESTIONS_SYSTEM = `You help ${AUDIENCE}
He is about to write a Medium article from his own experience. Ask him 4 or 5 questions that pull out the story only
he can tell: why he made a decision, what he expected, what surprised or frustrated him, what he got wrong, what he
would tell a beginner.

- NEVER ask him for a fact, number, date, month, name or result. Everything that is known is already in the data; what
  is not in the data (e.g. which months were green) is not known, so do not ask about it either. Ask only about his
  thinking and feelings around the facts.
- You may anchor a question on one fact, stated in plain words in the question itself ("Your very first version lost
  money in 8 of the 9 months it traded. What did you think when you saw that?").
- Each question must make sense to him without looking anything up, and be answerable in a few spoken sentences.
  Max 35 words. No yes/no questions, no generic "what did you learn".
${PLAIN}
${NEVER}`;

export const DRAFT_SYSTEM = `You arrange ${AUDIENCE}
Medium's Partner Program does not allow AI-written articles behind the paywall, and this account is his income. So the
article MUST be his words:
- Build the body from his answers, keeping his own sentences. You may: reorder them, cut repetition and filler
  ("um", "like", "so yeah"), fix grammar and typos, split long sentences, and add short section headings (max 6 words).
- You may add at most one short linking sentence per section, and an opening line only if his answers have none.
  Nothing else of your own. If his answers are thin, the article is short: do not pad it.
- Numbers only from the data or his answers, written exactly as given (rounding to 1 decimal is fine).
- Refer to stocks only by the labels in the data ("Stock A" etc. stay as they are), and say once why names are hidden.
- You MAY add short plain explanations of terms (a clause or one sentence) wherever a beginner would get lost; these
  are the only other words of your own allowed.
${PLAIN}
${NEVER}

Format of "draft" (plain text, markdown-lite): "## " section headings (3 to 6 sections), "- " bullet lines, **bold**
sparingly, "> " for one standout line of his. No H1 title and no image lines inside the draft (images are placed by
code under each heading).

Images: he generates them himself in Gemini from your prompts. Write one for the cover ("cover") and one for EACH
"## " section, in the same order as the headings ("sections"). His taste, from his own Medium covers:
- a photograph of a real-world scene, never a generic stock look: e.g. a laptop screen at dawn, a phone notification,
  a search bar, a sticky note on a monitor, a notebook page, a book cover, a chai cup beside a keyboard
- the hook is written INSIDE the scene on an object (the screen, the note, the book), not pasted on top
- moody low-key light, warm amber-gold with an emerald-teal edge, shallow depth of field, ONE focal point
- for an explainer section a clean flat illustration (simple shapes, his colours) is fine instead of a photo
- decorative chart shapes are fine only blurred in the background: never a readable chart, axis or number as data
- no logos, brands, app names (a "search bar", not Google), no real people
For each image:
- hook: the words shown in the image, max 6 words, punchy, true to the data or his answers (or "" for no text).
  The cover hook is the scroll-stopper: a real number with tension, or a question a beginner would click.
- scene: 2-4 sentences: the subject, where the hook is written, the setting, light and camera. Do not repeat the
  shared style (it is added automatically) and do not put the hook text in the scene except as "the hook".
- caption: one short witty line in his voice, like "Me: considers doing X / ChatGPT: 'Hold my prompt.'" (the AI
  label is added automatically).

Publish kit:
- title: max 70 characters, specific, with a real number and tension, understandable by a non-trader.
- subtitle: max 140 characters, says what the reader gets.
- tags: exactly 5 Medium tags, lower case, the ones readers of this topic follow (e.g. "algorithmic trading",
  "day trading", "machine learning", "stock market", "trading psychology"); never tickers or brand names.
- captions: for the optional real-data charts listed below, one factual caption each (max 120 characters).`;

export const QUESTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: { questions: { type: 'array', items: { type: 'string' } } },
} as const;

const AI_IMAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['hook', 'scene', 'caption'],
  properties: { hook: { type: 'string' }, scene: { type: 'string' }, caption: { type: 'string' } },
} as const;

export const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['draft', 'title', 'subtitle', 'tags', 'captions', 'cover', 'sections'],
  properties: {
    draft: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' },
    cover: AI_IMAGE_SCHEMA,
    sections: { type: 'array', items: AI_IMAGE_SCHEMA },
    tags: { type: 'array', items: { type: 'string' } },
    captions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'caption'], properties: { id: { type: 'string' }, caption: { type: 'string' } } } },
  },
} as const;

const data = (a: Article) => {
  const f = FORMATS.find((x) => x.id === a.format)!;
  return [`ARTICLE TYPE: ${f.name} (${f.what}). Period: ${a.material.period.label}.`, 'DATA (real, from his journal / app):', ...factsFor(a.material, a.shared).map((l) => `- ${l}`)].join('\n');
};

export const questionsMessage = (a: Article) => data(a);

export function draftMessage(a: Article): string {
  const qa = a.questions.map((q, i) => `Q${i + 1}: ${q}\nHIS ANSWER: ${(a.answers[i] ?? '').trim() || '(no answer)'}`).join('\n\n');
  const imgs = a.material.images.filter((i) => i.data.kind !== 'banner').map((i) => `- ${i.id}: ${i.title}`).join('\n');
  return `${data(a)}\n\nOPTIONAL REAL-DATA CHARTS (captions only):\n${imgs || '- none'}\n\nHIS ANSWERS (the article is made of these):\n${qa}`;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function askQuestions(a: Article, o: ClaudeOptions = claudeOptions()): Promise<{ questions: string[]; costInr: number }> {
  const r = await jsonClaude(QUESTIONS_SYSTEM, questionsMessage(a), QUESTIONS_SCHEMA, { ...o, timeoutMs: 60_000 }, 1200);
  const all = (Array.isArray(r.json.questions) ? r.json.questions : []).map((q) => clip(q, 240)).filter(Boolean);
  // he should never be asked for data tradereye already has (or does not have): drop questions that ask for a fact
  const kept = all.filter((q) => !asksForFact(q));
  const qs = (kept.length >= 3 ? kept : all).slice(0, 5);
  if (!qs.length) throw new Error(r.cutOff ? 'Claude\'s answer was cut short.' : 'Claude returned no questions.');
  return { questions: qs, costInr: r.costInr };
}

export async function writeDraft(a: Article, o: ClaudeOptions = claudeOptions()): Promise<{ draft: string; kit: Kit; costInr: number }> {
  const r = await jsonClaude(DRAFT_SYSTEM, draftMessage(a), DRAFT_SCHEMA, { ...o, timeoutMs: 150_000 }, 9000);
  const j = r.json as { draft?: string; title?: string; subtitle?: string; tags?: unknown; captions?: { id?: string; caption?: string }[]; cover?: unknown; sections?: unknown };
  if (!j.draft) throw new Error(r.cutOff ? 'Claude\'s answer was cut short.' : 'Claude returned no draft.');
  const ids = new Set(a.material.images.map((i) => i.id));
  const captions: Record<string, string> = {};
  for (const i of a.material.images) if (i.caption) captions[i.id] = i.caption;
  for (const c of Array.isArray(j.captions) ? j.captions : []) if (c?.id && ids.has(c.id) && c.caption) captions[c.id] = clip(c.caption, 160);
  // every section opens with its image: markers placed by code, prompts matched to the headings by order
  const body = placeSectionMarkers(cleanDraft(String(j.draft).replace(/^\s*\[IMAGE [^\]]+\]\s*$/gm, ''), a.material.images));
  const ai = toAiImages(j.cover, j.sections, sectionsOf(body));
  return {
    draft: withDisclaimer(body, a.material.oldPrices),
    kit: { title: clip(j.title, 100), subtitle: clip(j.subtitle, 160), tags: cleanTags(j.tags), captions, ai },
    costInr: r.costInr,
  };
}
