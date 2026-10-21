# .basetobase/ — agent templates and CI config

- `patrol/<role-id>.md` — one template per enabled patrol role (`enabledRoles` in basetobase/config/basetobase.json); filename = roster role id.
- A role with no template fails its agent ("cannot read agent templates").
- `patrol/_verdict.md` — added to every patrol prompt after the role template; the verdict contract `parseVerdict` (basetobase/shared/src/verdict.ts) enforces. Keep them in sync.
- Template style: direct, terse, one imperative rule per line, ≤40 lines, no preamble or rationale.
- Templates and the forwarder are read from the default branch, never the PR head (a PR cannot rewrite its own reviewer); an edit here takes effect once merged.
- `ci/local.yml` — CI-safe config the agent job copies to `local.yml` in the PR checkout, where the app reads its config; must track every key in the app's `config.yml`.
