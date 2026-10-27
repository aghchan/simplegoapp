// The title of Granite Chief's missing-design hazard (.basetobase/patrol/granite-chief.md). The
// owner's bypass waives Granite Chief's first hazard of this title; no other hazard may take it.
export const NO_DESIGN_TITLE = "No approved design";

// The PRs whose after-the-fact design a PR's description says it is: its `For: #<n>` lines, whole
// lines only, in order, each once. A PR's description is part of the run's goal.
export function coversOf(goal: string): number[] {
  const covered = new Set<number>();
  for (const [, pr] of goal.matchAll(/^For: #(\d+)\s*$/gm)) covered.add(Number(pr));
  return [...covered];
}
