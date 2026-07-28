/** Commands the client handles itself, before anything reaches the server or
 *  the agent.
 *
 *  `PromptBar.submit` routes ANY slash input to the skill router, so a client
 *  command has to be recognised ahead of that branch — otherwise `/exit`
 *  becomes a skill suggestion.
 *
 *  Reserved names win over plugin skills. The slash autocomplete matches
 *  substrings across every installed skill, so a plugin could ship one called
 *  `exit`; if that ever happens the menu will offer it while this parser still
 *  intercepts the text. That is the decision, not an oversight (spec §4). */
export type ClientCommand = { type: "exit" };

/** Exact, argument-free match. `/exits` and `/exit now` deliberately fall
 *  through to the skill router: swallowing a longer name would silently
 *  shadow a real skill, and the failure would look like the skill is broken. */
export function parseClientCommand(text: string): ClientCommand | null {
  if (text.trim().toLowerCase() === "/exit") return { type: "exit" };
  return null;
}

/** Whether Enter should bypass the slash-autocomplete menu and reach
 *  `submit()` even while the menu is open with a highlighted match. True only
 *  for an exact reserved command (see `parseClientCommand`) — a real skill
 *  name, or a longer name that merely starts with a reserved word (e.g.
 *  `/exit-plan-mode`), must still accept from the menu as normal. Pulled out
 *  as a pure predicate so `PromptBar`'s `onKeyDown` has something testable to
 *  consult: this repo has no component-test infrastructure, so logic left
 *  inline in the keydown handler would ship untested. */
export function shouldSubmitOverMenu(text: string): boolean {
  return parseClientCommand(text) !== null;
}
