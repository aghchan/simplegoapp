import picomatch from "picomatch";
import type { B2BConfig, Panel, Rating } from "./config.ts";

export interface ChangedFile {
  path: string;
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
  return picomatch(globs, { dot: true });
}

function anyMatch(files: ChangedFile[], globs: string[]): boolean {
  const isMatch = globMatcher(globs);
  return files.some((file) => isMatch(file.path));
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
  const panels: Panel[] = [];
  if (files.some((file) => !isFrontend(file.path))) panels.push("backend");
  if (files.some((file) => isFrontend(file.path))) panels.push("frontend");
  return panels;
}

export function rateChange(files: ChangedFile[], cfg: B2BConfig): Rating {
  const { thresholds } = cfg;
  const { additions, deletions } = sumLines(files);
  const lines = additions + deletions;
  const topDirs = new Set(files.map((file) => topLevelDir(file.path))).size;

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

export function pickRunName(rating: Rating, activeNames: string[], cfg: B2BConfig): string {
  const active = new Set(activeNames);
  // Terminates because loadConfig rejects empty trail name lists.
  for (let lap = 1; ; lap++) {
    for (const name of cfg.trailNames[rating]) {
      const candidate = lap === 1 ? name : `${name} ${lap}`;
      if (!active.has(candidate)) return candidate;
    }
  }
}

export function triage(files: ChangedFile[], activeNames: string[], cfg: B2BConfig): Triage {
  const rating = rateChange(files, cfg);
  const { additions, deletions } = sumLines(files);
  return {
    panels: classifyPanels(files, cfg),
    rating,
    runName: pickRunName(rating, activeNames, cfg),
    files: files.length,
    additions,
    deletions,
  };
}
