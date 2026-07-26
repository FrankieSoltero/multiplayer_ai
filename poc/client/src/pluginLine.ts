/** Transcript copy for plugin_change events — pure so it's testable
 *  (component-test infra doesn't exist in this repo; established pattern). */
export function pluginLine(
  action: string | undefined,
  name: string | undefined,
  skillCount: number | undefined,
): string {
  if (action === "remove") return `removed plugin ${name}`;
  return `added plugin ${name} (${skillCount ?? 0} skills) — applies to sessions started from now`;
}
