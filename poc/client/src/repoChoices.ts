import type { MachineInfo } from "./types";

/** One line in the create form's repo select: a specific repo on a specific
 *  machine, which is exactly what `create_session` routes on (spec §8). */
export type RepoChoice = {
  machineId: string;
  machineName: string;
  repoKey: string;
  label: string;
  defaultBranch: string | null;
};

/** One choice per (online machine, attached repo) pair, in machine order.
 *
 *  Offline machines and unattached candidates are absent rather than shown
 *  and refused: the same repo key can be attached on two machines at once,
 *  so the pair — not the key — is the unit of choice. */
export function repoChoices(machines: MachineInfo[]): RepoChoice[] {
  const choices: RepoChoice[] = [];
  for (const machine of machines) {
    if (!machine.online) continue;
    for (const repo of machine.repos) {
      if (!repo.attached) continue;
      choices.push({
        machineId: machine.machineId,
        machineName: machine.name,
        repoKey: repo.key,
        label: `${repo.label} — ${machine.name}`,
        defaultBranch: repo.defaultBranch,
      });
    }
  }
  return choices;
}

/** The choice to act on: an explicit pick while it still exists, else the
 *  first choice, else null.
 *
 *  Matched by value, not identity — every project snapshot rebuilds the list,
 *  and a pick that survived the refresh must not silently jump machines. */
export function chooseRepo(
  choices: RepoChoice[],
  picked: { machineId: string; repoKey: string } | null,
): RepoChoice | null {
  if (picked !== null) {
    const exact = choices.find(
      (c) => c.machineId === picked.machineId && c.repoKey === picked.repoKey,
    );
    if (exact) return exact;
  }
  return choices[0] ?? null;
}

/** The `<option value>` for a choice: the pair, joined. */
export function choiceValue(choice: { machineId: string; repoKey: string }): string {
  return `${choice.machineId}:${choice.repoKey}`;
}

/** Read a pair back out of an `<option value>`.
 *
 *  Split on the FIRST colon only — a repo key with no remote is
 *  `local:<host>:<digest>`, so `.split(":")` would hand back a repoKey of
 *  "local" and route the create at a repo that does not exist. */
export function parseChoiceValue(value: string): { machineId: string; repoKey: string } | null {
  const cut = value.indexOf(":");
  if (cut <= 0 || cut === value.length - 1) return null;
  return { machineId: value.slice(0, cut), repoKey: value.slice(cut + 1) };
}

/** How much of a repo key to show when two repos share a label. Long enough
 *  to be recognizable, short enough not to swamp the label it qualifies. */
const MIN_KEY_PREFIX = 8;

/** repoKey → display label, from every repo every machine knows about —
 *  attached or not, online or not — because a session outlives the machine
 *  that served it and its repo still deserves a name (spec §8).
 *
 *  Two distinct keys can share a basename label ("api" in two orgs, or two
 *  clones with no remote). Those get their key prefix appended, so the label
 *  stays honest about there being two repos. */
export function repoLabels(machines: MachineInfo[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const machine of machines) {
    // First declaration wins: the same key on two machines is the same repo,
    // and a stable label beats whichever machine happens to be last.
    for (const repo of machine.repos) if (!labels.has(repo.key)) labels.set(repo.key, repo.label);
  }

  const keysByLabel = new Map<string, string[]>();
  for (const [key, label] of labels) {
    const bucket = keysByLabel.get(label);
    if (bucket) bucket.push(key);
    else keysByLabel.set(label, [key]);
  }

  for (const [label, keys] of keysByLabel) {
    if (keys.length < 2) continue;
    const width = distinguishingWidth(keys);
    for (const key of keys) {
      const shown = key.length > width ? `${key.slice(0, width)}…` : key;
      labels.set(key, `${label} (${shown})`);
    }
  }
  return labels;
}

/** The shortest prefix width that tells these keys apart, floored at
 *  MIN_KEY_PREFIX. A fixed width would not do: `local:<host>:<digest>` keys
 *  differ only in the trailing digest, so eight characters of every one of
 *  them reads `local:fr` and disambiguates nothing. The keys are distinct, so
 *  the full-length fallback always separates them. */
function distinguishingWidth(keys: string[]): number {
  const longest = Math.max(...keys.map((key) => key.length));
  for (let width = MIN_KEY_PREFIX; width < longest; width++) {
    if (new Set(keys.map((key) => key.slice(0, width))).size === keys.length) return width;
  }
  return longest;
}
