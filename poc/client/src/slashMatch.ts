// Pure helpers for the prompt bar's slash autocomplete (spec:
// docs/superpowers/specs/2026-07-26-slash-autocomplete-v2-design.md).

export interface Skill {
  name: string;
  description: string;
}

/** Case-insensitive substring match on the name; prefix matches rank first,
 *  original roster order preserved within each group. Empty token = full list. */
export function matchSkills(token: string, skills: Skill[]): Skill[] {
  const t = token.toLowerCase();
  if (!t) return skills.slice();
  const prefix: Skill[] = [];
  const rest: Skill[] = [];
  for (const s of skills) {
    const n = s.name.toLowerCase();
    if (n.startsWith(t)) prefix.push(s);
    else if (n.includes(t)) rest.push(s);
  }
  return [...prefix, ...rest];
}

/** Wrap-around highlight step; 0 when the list is empty. */
export function moveHighlight(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/** Minimal junk filter: the live SDK roster is known to contain dead entries
 *  whose description starts with "(removed" (v6c plan §Deviations). The SDK's
 *  SlashCommand type has no skill-vs-command discriminator, so this stays a
 *  deliberately narrow heuristic. */
export function notRemoved(s: Skill): boolean {
  return !s.description.trimStart().startsWith("(removed");
}
