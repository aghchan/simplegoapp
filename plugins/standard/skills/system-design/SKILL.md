---
name: system-design
description: Use after the what and why are agreed, before any code for a change bigger than a simple bug fix; also to revise an approved design, or to write the design a bypassed emergency change owes.
---

## Files
- Rules: `${CLAUDE_PLUGIN_ROOT}/rules.md`, for when a design is required and what a simple bug fix is.
- Template: `${CLAUDE_PLUGIN_ROOT}/skills/system-design/template.md`.
- Contract: `${CLAUDE_PLUGIN_ROOT}/skills/system-design/lenses/_challenge.md`.
- Lens of role id `<id>`: `${CLAUDE_PLUGIN_ROOT}/skills/system-design/lenses/<id>.md`.

## Size and panel
- Size: short for a chore, a dependency bump, a docs-only change or another small change; full for anything else.
- Full panel: every lens except `magic-carpet` and `bluebird`, which join only when the design adds or changes a screen.
- Short panel: `granite-chief`, each lens whose section is not "None", and `magic-carpet` and `bluebird` when the design adds or changes a screen.
- A lens's section: `corduroy` "Fit with existing features", `summit-six` "Scaling", `gold-coast` "Infrastructure and dependencies", `kt-22` "Security", `mainline` "How we'll know it works".
- Every panel: `builder`.
- Add any lens the owner names.
- No Agent tool: tell the owner the panel cannot run; never play a lens yourself.

## Draft
- Fill in the template from the agreed what and why, reading the code each section touches.
- Save it as `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- Leave no `>` line from the template, the size rules included.
- Under "Design review", write only `Panel: <prefixes>, <why this panel>`, `<prefixes>` being each panel lens's challenge-id prefix.
- Set Status to `in review`; the draft is revision 1.

## Sweep
- Dispatch one Agent tool subagent per panel lens, all in one message, in parallel.
- Prompt each: `Sweep. Revision: <N>. Lens: <lens path>. Contract: <contract path>. Design: <design path>. Next id: <PREFIX>-<n>. Return only the JSON object.`
- `Next id`: the lens's prefix and one more than that prefix's highest number in the review record, or 1 when it has none.
- Dispatch a lens again when its return is not one JSON object in the contract, or its `role` or `revision` differs from the dispatch.

## Answer
- Answer every challenge the round returned. Never close one yourself: only its lens or an owner ruling closes it.
- `unspecified`: never guess. Make it an owner question with your proposed answer and its reason.
- `flaw` or `defend`: revise the design, or reply with evidence from the design or the repo, citing file:line.
- A challenge its lens keeps open after two answers: make it an owner question.

## Owner questions
- Ask all owner questions in one message, most important first.
- Each gives the challenge id, its `detail` (the lens's question and options), the specialist, why the design does not settle it, and your proposed answer.
- Two lenses asking the same question: one owner question naming both challenge ids.
- Wait for the rulings before the re-check.
- Write each ruling into "Decisions" marked **(owner)**; it closes its challenge.

## Re-check
- Add 1 to the revision when your answers changed any section but "Design review".
- Dispatch every panel lens again, open challenges or not, all in one message, in parallel.
- Prompt each: `Re-check. Revision: <N>. Lens: <lens path>. Contract: <contract path>. Design: <design path>. Challenges: <JSON>. Next id: <PREFIX>-<n>. Return only the JSON object.`
- `<JSON>`: an array of every challenge every lens returned in the round, each with an added `"answer"`: `revised <heading>`, your reply with its evidence, or `owner: <ruling>`.
- Read each return: a round's challenge left out is closed, one kept open carries the lens's `reply`, and a new id is a new challenge.

## Quorum
- Quorum: every panel lens returns `clear` on the same revision.
- Short of quorum, answer the round and re-check again.
- Never end the loop on your own; take what you cannot settle to the owner.

## Record
- Write "Design review" in the template's format as the loop goes.
- Each sweep or re-check is the next round.
- Under `Round <n>:`, add `- <id> <title>` for each new challenge the round returned.
- When a challenge closes, end its line with how: `: revised <heading>`, `: defended: <reason>`, `: owner: <ruling>`, or `: withdrawn` when its lens dropped it with no revision, reply or ruling aimed at it.
- At quorum, end the record with `Quorum: <prefixes> clear on revision <N>`.
- Name a revised section by its heading; keep `§<n>` for "Delivery" parts.

## Sign-off
- At quorum, hand the owner the design and every **(designer's call)** in "Decisions" to check.
- A change the owner asks for at sign-off: write it into "Decisions" as **(owner)**, revise, and re-check to a new quorum.
- On approval, set Status to `approved YYYY-MM-DD`, commit the design file alone, and open a PR whose only file is the design.
- Start code only after the design PR merges.

## Revisions
- Change an approved design only through this loop, on a branch, starting with a sweep and continuing the record's round and revision numbers.
- Land the revision in its own design PR, approved and merged before any code that depends on it.

## After a bypass
- A change the owner bypassed owes a short design of the change as built, through this loop.
- Its design PR's description says `For: #<n>`, the bypassed PR's number.
