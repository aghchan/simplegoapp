import picomatch from "picomatch";
import type { B2BConfig, Panel, Rating } from "./config.ts";

export interface ChangedFile {
  path: string;
  // A rename's old path still counts: moving a file out of a guarded path must not hide it.
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface Triage {
  panels: Panel[];
  rating: Rating;
  runName: string;
  files: number;
  additions: number;
  deletions: number;
}

function globMatcher(globs: string[]) {
  return picomatch(globs, { dot: true, nocase: true });
}

function allPaths(files: ChangedFile[]): string[] {
  return files.flatMap((file) =>
    file.previousPath === undefined ? [file.path] : [file.path, file.previousPath],
  );
}

function anyMatch(files: ChangedFile[], globs: string[]): boolean {
  const isMatch = globMatcher(globs);
  return allPaths(files).some((path) => isMatch(path));
}

function topLevelDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

function sumLines(files: ChangedFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

export function classifyPanels(files: ChangedFile[], cfg: B2BConfig): Panel[] {
  const isFrontend = globMatcher(cfg.frontendGlobs);
  const paths = allPaths(files);
  const panels: Panel[] = [];
  if (paths.some((path) => !isFrontend(path))) panels.push("backend");
  if (paths.some((path) => isFrontend(path))) panels.push("frontend");
  return panels;
}

export function rateChange(files: ChangedFile[], cfg: B2BConfig): Rating {
  const { thresholds } = cfg;
  const { additions, deletions } = sumLines(files);
  const lines = additions + deletions;
  const topDirs = new Set(allPaths(files).map((path) => topLevelDir(path))).size;

  if (
    lines > thresholds.doubleBlackLines ||
    anyMatch(files, cfg.infraGlobs) ||
    topDirs >= thresholds.doubleBlackTopDirs
  ) {
    return "double_black";
  }
  if (lines > thresholds.blueLines || anyMatch(files, cfg.riskGlobs)) return "black";
  if (lines <= thresholds.greenLines && files.length <= thresholds.greenFiles) return "green";
  return "blue";
}

// The names already given to runs of a rating: the ones active runs hold, and the newest run's.
export interface RunNames {
  active: string[];
  last?: string;
}

// The name after the rating's last, so each run gets a new one, skipping names active runs hold.
// Only when every name is taken does a lap number follow.
export function pickRunName(rating: Rating, taken: RunNames, cfg: B2BConfig): string {
  const names = cfg.trailNames[rating];
  const active = new Set(taken.active);
  const start = taken.last === undefined ? -1 : indexOfName(names, taken.last);
  // Terminates because loadConfig rejects empty trail name lists.
  for (let lap = 1; ; lap++) {
    for (let step = 1; step <= names.length; step++) {
      const name = names[(start + step) % names.length]!;
      const candidate = lap === 1 ? name : `${name} ${lap}`;
      if (!active.has(candidate)) return candidate;
    }
  }
}

// A trail's own number ("Chair 2") wins over reading it as a lap number; -1 for a name the list
// no longer has.
function indexOfName(names: string[], name: string): number {
  const exact = names.indexOf(name);
  return exact !== -1 ? exact : names.indexOf(name.replace(/ \d+$/, ""));
}

export function triage(files: ChangedFile[], names: RunNames, cfg: B2BConfig): Triage {
  const rating = rateChange(files, cfg);
  const { additions, deletions } = sumLines(files);
  return {
    panels: classifyPanels(files, cfg),
    rating,
    runName: pickRunName(rating, names, cfg),
    files: files.length,
    additions,
    deletions,
  };
}
