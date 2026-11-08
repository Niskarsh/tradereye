/** The ticked images not yet up as a Story today, so a second press sends only what is missing. No server code here: the page uses it. */
export function storiesToSend(chosen: string[], state: { stories: { slides: string[] }[] }): string[] {
  return chosen.filter((n) => !state.stories.some((s) => s.slides[0] === `story-${n}`));
}
