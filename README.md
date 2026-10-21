# simplegoapp

Go DI framework and template for spec-first JSON APIs. Conventions: [docs/BEST_PRACTICES.md](docs/BEST_PRACTICES.md).

Run locally: start Postgres on localhost:5432, copy [.basetobase/ci/local.yml](.basetobase/ci/local.yml) to `local.yml`, then `go run .`. It serves on localhost:8080; `GET /health` answers once it is up.

## Reviews

Every PR is reviewed by [Base to Base](basetobase/): adversarial patrollers, one specialty each, that try to break the change and challenge its design. An unjustified choice comes back as a `Defend:` hazard; answer it with evidence or fix it. Live runs: https://basetobase.soulygrail.workers.dev
