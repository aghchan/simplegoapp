# .basetobase/ — agent templates and CI config

- `patrol/<role-id>.md`: one per enabled role (`enabledRoles`, basetobase/config/basetobase.json). Missing → the agent fails.
- `patrol/_verdict.md`: appended to every patrol prompt. Shared adversarial stance, then the verdict contract; keep it in sync with `parseVerdict` (basetobase/shared/src/verdict.ts).
- Role templates add attacks for their criteria; never soften the stance.
- `<pr_description>`: named in `_verdict.md`, built by `buildPrompt` (basetobase/forwarder/src/prompt.ts). Rename both together.
- Style: one imperative rule per line, ≤40 lines. No preamble, rationale, hedging or politeness.
- Read from the default branch, never the PR head: edits apply once merged.
- claude runs with `--setting-sources user --strict-mcp-config`: the PR's `.claude/` settings and MCP config don't load.
- Not isolation: the reviewer reads PR code and CLAUDE.md as data, and PR code runs in the same job, as the forwarder's user.
- `ci/local.yml`: CI-safe config copied to `local.yml` in the PR checkout. Must track every key in `config.yml`.
