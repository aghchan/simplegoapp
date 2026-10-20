import type { AgentBrief } from "../../shared/src/types.ts";

export function buildPrompt(
  brief: AgentBrief,
  roleText: string,
  verdictText: string,
  verdictPath: string,
): string {
  return [
    roleText.trim(),
    `Goal:\n${brief.goal}`,
    `PR #${brief.prNumber}. Review: git diff ${brief.baseSha}...${brief.headSha}`,
    verdictText.trim(),
    `Write the verdict JSON to ${verdictPath}. Role: ${brief.role}. Head SHA: ${brief.headSha}. ` +
      `Hazard ids: ${brief.prefix}-N.`,
  ].join("\n\n");
}
