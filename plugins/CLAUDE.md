# plugins/ — Claude Code plugins published from this repo

- Marketplace: `.claude-plugin/marketplace.json` at the repo root lists each plugin. Source `./plugins/<name>`.
- `standard/` (`standard@simplegoapp`): the development standard. Delivered as a claude.ai account plugin; projects declare nothing.
- Plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/session-start`, `rules.md`, `skills/<name>/SKILL.md`.
- `rules.md` is the single source of the session rules. The hook injects it at session start; skills refer to it and never copy it.
- The hook reads `rules.md` and escapes it with bash builtins only, no external command. It finds its plugin root from `$0`.
- Prompt files, `rules.md` included: one imperative rule per line, ≤40 lines. No preamble, rationale, hedging or politeness.
- No CLAUDE.md inside a plugin: the plugin ships to other repos. Context for editing it lives here.
- Bump `plugin.json` `version` on each release. Account sync pulls only new versions.
- `plugins/standard` is also a Go package (`doc.go`, `standard_test.go`) so `go test ./plugins/...` covers the hook and `rules.md`.
- CI job `plugin` runs `claude plugin validate --strict` on the marketplace and on each plugin. Run both before committing.
