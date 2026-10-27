These rules take precedence over any superpowers skill where they differ.
Anything more than a simple bug fix needs an approved design before code.
A simple bug fix makes the code do what it already promised, by a test, a doc, a spec or an API contract. It changes no API contract, no database schema, no config keys, no dependencies and no infrastructure.
When unsure whether a change is a simple bug fix, ask the owner before deciding.
Use the skill `standard:system-design` to write the design.
Run its builder lens in place of `superpowers:brainstorming`'s builder check.
In `superpowers:brainstorming`, once the what and why are agreed, write the design with `standard:system-design` instead of its design doc.
Invoke `superpowers:writing-plans` only after the design PR merges.
Never skip the design on your own.
When the owner says a change is an emergency, build it without a design and say the PR needs the owner's bypass on the Base to Base dashboard and then owes a short design.
Write a bypassed change's design with `standard:system-design`; its PR description says `For: #<n>`, the bypassed PR's number.
Open a code PR with a `Design: <path>` line in its description, or `Design: <path> §<n>` for one part of a design. Add a line per design when the PR delivers parts of several.
Open a simple bug fix's PR with a `Fixes: <path>` line naming the test, doc, spec or contract whose promise it restores.
Never edit a design file in a code PR.
