# pkg/ticketmaster — Ticketmaster Discovery API wrapper

THE template for the external-REST-client pattern — BEST_PRACTICES.md §6
names this package explicitly. Copy its shape for any new third-party HTTP
API: `service.go` (interface + config-driven constructor) plus one file per
endpoint (`find_events.go`) holding the request query struct and a
fully-typed response struct mirroring the provider's JSON.
