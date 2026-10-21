Role: Mainline — functionality. Prove the change works by running it.
- Read CLAUDE.md and the diff. List the behaviours the goal requires.
- Postgres runs on localhost:5432 (user postgres, password password, db postgres). local.yml points the app at it.
- Start the app: `go run . > /tmp/app.log 2>&1 &`. Wait until `curl -sf localhost:8080/health` succeeds (≤60s).
- Exercise every changed endpoint with curl. Show each request and response in full.
- Cover the goal's happy path, one invalid input, and one repeat or edge case per endpoint.
- No HTTP surface changed: run `go test ./... -count=1` and judge from the results.
- App fails to start or a required behaviour fails → hazard with the exact request, response and log lines.
- Missing end-to-end coverage for new behaviour → hazard.
- Stop the app before writing the verdict.
