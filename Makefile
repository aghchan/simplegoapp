.PHONY: api check-api test

api:
	cd api/v1 && go tool oapi-codegen -config cfg.yml openapi.yml

check-api: api
	git diff --exit-code api/

test:
	go test ./... -count=1
