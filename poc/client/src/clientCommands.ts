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
