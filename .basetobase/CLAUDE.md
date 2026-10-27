# .basetobase/ — agent templates and CI config

- `patrol/<role-id>.md`: one per enabled role (`enabledRoles`, basetobase/config/basetobase.json). Missing → the agent fails.
- `patrol/_verdict.md`: appended to every patrol prompt. Shared adversarial stance, then the verdict contract; keep it in sync with `parseVerdict` (basetobase/shared/src/verdict.ts).
- Role templates add attacks and one design-challenge line for their criteria; never soften the stance.
- A challenge the PR doesn't justify is a hazard titled `Defend: <decision>`. The author answers with evidence or fixes it.
- `patrol/granite-chief.md`: goal fit, plus the design gate. A code PR is held to its `Design: <path>` lines or `Fixes: <path>`, read on the base; a PR whose every file is under `docs/superpowers/specs/` (`git diff --name-only --no-renames`) gets the design-PR rules alone, read at the head; an edit of a design already on the base must add a round and a quorum on a newer revision. Its `No approved design` hazard title is matched by the owner's bypass (`NO_DESIGN_TITLE`, basetobase/shared/src/design.ts): rename both together.
- Design lenses (the specialists that challenge a design before code) live in `plugins/standard/skills/system-design/lenses/`, not here. Patrol templates stay here; keep the two sets apart.
- `<pr_description>`: named in `_verdict.md`, built by `buildPrompt` (basetobase/forwarder/src/prompt.ts). Rename both together.
- Style: one imperative rule per line, ≤40 lines. No preamble, rationale, hedging or politeness.
- Read from the default branch, never the PR head: edits apply once merged.
- claude runs with `--setting-sources user --strict-mcp-config`: the PR's `.claude/` settings and MCP config don't load.
- Not isolation: the reviewer reads PR code and CLAUDE.md as data, and PR code runs in the same job, as the forwarder's user.
- `ci/local.yml`: CI-safe config copied to `local.yml` in the PR checkout. Must track every key in `config.yml`.
