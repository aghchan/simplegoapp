# .basetobase/ — agent templates and CI config

- `patrol/<role-id>.md` — one template per enabled patrol role (`enabledRoles` in basetobase/config/basetobase.json); filename = roster role id.
- A role with no template fails its agent ("cannot read agent templates").
- `patrol/_verdict.md` — added to every patrol prompt after the role template: the adversarial stance every patroller shares, then the verdict contract `parseVerdict` (basetobase/shared/src/verdict.ts) enforces. Keep the contract and `parseVerdict` in sync.
- Every patroller is an adversarial reviewer. Role templates add attacks for their criteria; they never soften the shared stance.
- `_verdict.md`'s data rule names the `<pr_description>` block that `buildPrompt` (basetobase/forwarder/src/prompt.ts) fences the PR title and body in; rename both together.
- Template style: direct, terse, one imperative rule per line, ≤40 lines, no preamble or rationale.
- Templates and the forwarder are read from the default branch, never the PR head; an edit here takes effect once merged.
- claude runs with `--setting-sources user --strict-mcp-config`, so the PR's `.claude/` settings (hooks, env, permissions) and MCP config are not loaded.
- That does not isolate the reviewer from the PR: it still reads PR content (code, CLAUDE.md) as data, and PR code runs in the same job, as the forwarder's user.
- `ci/local.yml` — CI-safe config the agent job copies to `local.yml` in the PR checkout, where the app reads its config; must track every key in the app's `config.yml`.
