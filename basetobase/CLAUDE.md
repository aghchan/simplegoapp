# basetobase/ — Base to Base (agent CI/CD)

Spec: docs/superpowers/specs/2026-10-20-base-to-base-design.md

- Own Go module (go.mod) keeps this tree out of `go ./...` and module zips. Never add Go code here.
- One npm package. Units: shared/ (pure, no deps but picomatch), dispatch/ (Worker + RunDO), forwarder/ (Node on runners), dashboard/ (React SPA).
- Relative imports with .ts extensions. Erasable TS only (forwarder runs via Node type stripping).
- Run logic lives in dispatch/src/run/machine.ts as pure transitions returning effects; RunDO only persists and executes effects.
- Commands: npm test · npm run typecheck · npm run dev · npm run deploy
