# plugins/ — Claude Code plugins published from this repo

- Marketplace: `.claude-plugin/marketplace.json` at the repo root lists each plugin. Source `./plugins/<name>`.
- `standard/` (`standard@simplegoapp`): the development standard. Delivered as a claude.ai account plugin; projects declare nothing.
- Plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/session-start`, `rules.md`, `skills/<name>/SKILL.md`.
- `rules.md` is the single source of the session rules. The hook injects it at session start; skills refer to it and never copy it.
- The hook reads `rules.md` and escapes it with bash builtins only, no external command. It finds its plugin root from `$0`.
- House style binds every agent-read file (`rules.md`, `SKILL.md`, the lenses, `_challenge.md`): one imperative rule per line. No preamble, rationale, hedging or politeness.
- The ≤40-line cap binds `rules.md`, the lenses and `_challenge.md`.
- `skills/system-design/template.md` is a fill-in document, exempt from the 40-line cap.
- No CLAUDE.md inside a plugin: the plugin ships to other repos. Context for editing it lives here.
- Bump `plugin.json` `version` on each release. Account sync pulls only new versions.
- `plugins/standard` is also a Go package (`doc.go`, `standard_test.go`) so `go test ./plugins/...` covers the hook, `rules.md`, the template's headings and `Panel:` line, the lens heads and line caps, the challenge contract and the skill's paths and panel lines.
- Lenses: one per roster role (basetobase/config/basetobase.json) except `groomer`, plus `builder.md`, beside `_challenge.md`. Nothing else goes in `lenses/`.
- A lens's first line is `Lens: <name> — <role>`, the roster's name and role (`Lens: Builder — Plannability` for the builder). Its second is `Role id: <id>. Challenge ids: <PREFIX>-<n>.`, the roster's id and prefix.
- The template's `## ` headings and its `Panel: <prefixes>. Why: <reason>` line are an interface shared with `.basetobase/patrol/granite-chief.md`, and the lenses cite the headings by exact text. Change them together.
- CI job `plugin` runs `claude plugin validate --strict` on the marketplace and on each plugin. Run both before committing.
