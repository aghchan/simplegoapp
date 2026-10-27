import { runInDurableObject } from "cloudflare:test";
import { NO_DESIGN_TITLE } from "../../shared/src/design.ts";
import type { AgentSnapshot } from "../../shared/src/types.ts";
import type { runStub } from "../src/runs/index.ts";
import type { RunState } from "../src/run/machine.ts";

export const GRANITE = "granite-chief-sweep-0";

// Dispatch tests run Mainline alone (the ENABLED_ROLES binding), so Granite Chief joins a started
// run through its stored state. By default it has reported the missing-design finding; `over`
// replaces what it holds.
export async function addGraniteChief(
  stub: ReturnType<typeof runStub>,
  over: Partial<AgentSnapshot> = {},
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const run = (await state.storage.get<RunState>("state"))!;
    const granite: AgentSnapshot = {
      id: GRANITE,
      role: "granite-chief",
      step: "sweep",
      round: 0,
      status: "hazards",
      finishedAt: Date.now(),
      hasTranscript: false,
      summary: "1 found.",
      hazards: [{ id: "DES-1", title: NO_DESIGN_TITLE, detail: "The PR names no design." }],
      ...over,
    };
    await state.storage.put("state", {
      ...run,
      agents: [...run.agents, granite],
      nonces: { ...run.nonces, [GRANITE]: "granite-nonce" },
      agentNames: { ...run.agentNames, [GRANITE]: "Granite Chief" },
    });
  });
}
