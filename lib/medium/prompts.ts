/**
 * Image prompts for the Medium article (pure). Tradereye does not generate images: the Draft call writes one Gemini
 * prompt for the cover and one per section, and he generates the images himself (no image API cost).
 *
 * His taste (from his own Medium covers): photographs of real-world scenes, moody low-key light (warm amber, teal),
 * shallow depth of field, one focal point, and the hook written INSIDE the scene (a search bar, a book cover, a
 * screen), with a witty caption under it. Sometimes a clean flat illustration for an explainer section.
 *
 * Rules enforced here, whatever Claude wrote:
 *  - the only readable text is the hook (max 6 words), spelled exactly; everything else blurred and unreadable
 *    (Gemini garbles small text)
 *  - no logos, brand or app names, real people, or legible numbers / charts presented as data (decorative,
 *    out-of-focus chart shapes are fine)
 *  - every caption ends with "(AI-generated image)": Medium requires AI images to be captioned as such
 *    (help.medium.com, "Artificial Intelligence (AI) content policy")
 */

export interface AiImage {
  /** "cover" for the top image, "s1", "s2", ... for sections (the draft marks them as [IMAGE s1]) */
  id: string;
  /** the section heading it belongs to ("" for the cover) */
  section: string;
  /** the words shown inside the image, max 6 words ("" = no text at all) */
  hook: string;
  /** what the picture shows: subject, setting, light, camera */
  scene: string;
  /** his witty caption; the AI label is added by code */
  caption: string;
}

export const AI_LABEL = '(AI-generated image)';

/** The look shared by every image (editable in settings), so his articles are recognisable in the feed. */
export const DEFAULT_STYLE = [
  'Cinematic photograph, 16:9 landscape, high resolution.',
  'Dark, moody, low-key lighting: warm amber-gold key light with a subtle emerald-teal rim light; deep charcoal shadows (not blue).',
  'Shallow depth of field (35mm lens, f/1.8): one sharp focal point, everything else softly blurred.',
  'Real-world objects and textures, a quiet early-morning desk-before-work mood; premium, editorial, magazine-cover quality.',
].join(' ');

const AVOID = 'Avoid: logos, brand names, app names, real people or celebrities, watermarks, borders, collage, legible numbers, ' +
  'charts or price screens presented as real data (decorative, out-of-focus chart shapes are fine), any text other than stated above.';

export const cleanHook = (h: unknown) => String(h ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 48);

/** His caption with the AI label, once. */
export function aiCaption(c: unknown): string {
  const s = String(c ?? '').replace(/\s*\(?AI[- ]generated image\)?\.?\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return s ? `${s} ${AI_LABEL}` : AI_LABEL;
}

/** The full prompt he pastes into Gemini: the scene, the text rule, the shared style, and what to avoid. */
export function buildPrompt(img: Pick<AiImage, 'hook' | 'scene'>, style = DEFAULT_STYLE): string {
  const hook = cleanHook(img.hook);
  const text = hook
    ? `Text: the ONLY readable text in the image is "${hook}", spelled exactly like that, large, bold and perfectly sharp, written naturally on an object in the scene (as described). All other text, screens and labels are soft, blurred and unreadable.`
    : 'Text: no readable text anywhere in the image.';
  return [img.scene.trim(), text, `Style: ${style.trim() || DEFAULT_STYLE}`, AVOID].join('\n\n');
}

/** The section headings of a draft, in order. */
export const sectionsOf = (draft: string) => draft.split('\n').map((l) => l.match(/^\s*##\s+(.*)$/)?.[1]?.trim()).filter((x): x is string => !!x);

/**
 * Puts [IMAGE s1], [IMAGE s2], ... right under each section heading (the image opens the section, the way he
 * structures his articles). Section markers already in the draft are replaced; other image lines are kept.
 */
export function placeSectionMarkers(draft: string): string {
  const out: string[] = [];
  let n = 0;
  for (const l of draft.split('\n')) {
    if (/^\s*\[IMAGE s\d+\]\s*$/.test(l)) continue;
    out.push(l);
    if (/^\s*##\s+/.test(l)) out.push('', `[IMAGE s${++n}]`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Headings whose section has no image line under it (added after the draft, or its line was deleted). */
export function sectionsWithoutImage(draft: string, ai: AiImage[]): string[] {
  const lines = draft.split('\n'), missing: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\s*##\s+(.*)$/);
    if (!h) continue;
    const next = lines.slice(i + 1).find((l) => l.trim());
    const m = next?.match(/^\s*\[IMAGE (s\d+)\]\s*$/);
    if (!m || !ai.some((x) => x.id === m[1])) missing.push(h[1].trim());
  }
  return missing;
}

/** Claude's cover + sections -> AiImage[] matched to the draft's section markers by order. */
export function toAiImages(cover: unknown, sections: unknown, headings: string[]): AiImage[] {
  const c = (cover ?? {}) as Partial<AiImage>;
  const list = Array.isArray(sections) ? sections as Partial<AiImage>[] : [];
  const out: AiImage[] = [];
  if (c.scene) out.push({ id: 'cover', section: '', hook: cleanHook(c.hook), scene: String(c.scene).slice(0, 1200), caption: aiCaption(c.caption) });
  headings.forEach((h, i) => {
    const s = list[i];
    if (s?.scene) out.push({ id: `s${i + 1}`, section: h, hook: cleanHook(s.hook), scene: String(s.scene).slice(0, 1200), caption: aiCaption(s.caption) });
  });
  return out;
}

/** His edits to the prompts, cleaned (ids kept, the caption label put back). */
export function cleanAiImages(x: unknown): AiImage[] {
  return (Array.isArray(x) ? x : []).slice(0, 20)
    .filter((i): i is AiImage => !!i && /^(cover|s\d+)$/.test(String((i as AiImage).id)))
    .map((i) => ({ id: i.id, section: String(i.section ?? '').slice(0, 120), hook: cleanHook(i.hook), scene: String(i.scene ?? '').slice(0, 1200), caption: aiCaption(i.caption) }));
}
