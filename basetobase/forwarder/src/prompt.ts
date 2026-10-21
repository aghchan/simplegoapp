import type { AgentBrief } from "../../shared/src/types.ts";

export function buildPrompt(
  brief: AgentBrief,
  roleText: string,
  verdictText: string,
  verdictPath: string,
): string {
  return [
    roleText.trim(),
    `Goal:\n${fencePrText(brief.goal)}`,
    `PR #${brief.prNumber}. Review: git diff ${brief.baseSha}...${brief.headSha}`,
    verdictText.trim(),
    `Write the verdict JSON to ${verdictPath}. Role: ${brief.role}. Head SHA: ${brief.headSha}. ` +
      `Hazard ids: ${brief.prefix}-N.`,
  ].join("\n\n");
}

// The PR author wrote this text; _verdict.md names the block as data. A delimiter inside it is
// escaped so the text cannot close the block early, or open another.
function fencePrText(text: string): string {
  const inert = text.replace(/<(?=\s*\/?\s*pr_description\b)/gi, "&lt;");
  return `<pr_description>\n${inert}\n</pr_description>`;
}
