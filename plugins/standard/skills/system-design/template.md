# <Title>

- Size: full | short
- Status: draft | in review | approved YYYY-MM-DD
- From: <link to the conversation or issue it came from>

> Size rules. Replace each `>` guide line with the section's content.
> - Short means one or two lines per section.
> - "None" needs a reason.
> - Delivery names its parts `§<n>` so PRs can point at them.

## What we're building

> The feature, and who it is for.

## Why

> The problem, why now, and what success looks like.

## Goals, non-goals, anti-goals

> What it must achieve, what it leaves out for now, and the failures to avoid even if everything works.

## Fit with existing features

> Every service, controller, endpoint, `pkg/` integration, table and config key it touches or changes, and what each existing caller sees afterwards. Name any duplication with an existing feature.

## API contract

> The diff to `api/v1/openapi.yml`, or "None" and why. Public endpoints are spec-first, so the contract is settled here, not during implementation.

## Data model and migrations

> Tables, columns and indexes, and whether each migration is safe for the version still serving.

## Scaling

> Load and data growth as numbers (requests per second, rows, payload sizes), the hot paths, concurrency and locking, and what breaks first as they grow.

## Infrastructure and dependencies

> New services, libraries with versions, config keys, secrets, and anything that costs money or uses up a free tier.

## Security

> Who can call it, input validation at the edge, and where secrets and personal data go, logs and error messages included.

## Failure and rollback

> Each dependency being down, partial failures, and how a bad release is undone, data included.

## How we'll know it works

> The end-to-end tests to commit, and the evidence a reviewer will see.

## Approaches

> Two or three, what each trades off, which was picked and why.

## Delivery

> How the work splits into PRs or milestones. Name each part `§1`, `§2` and so on, with what it ships.

## Decisions

> The owner's, marked **(owner)**, and Claude's, marked **(designer's call)**.

## Left to the builder

> What the design leaves for the builder to settle, where either choice is fine.

## Design review

> Written by the loop, not the author: the panel and why, each round's challenges and how each was settled, then the quorum line.

Panel: <prefixes>, <why this panel>

Round <n>:
- <id> <title>: revised §n
- <id> <title>: defended: <reason>
- <id> <title>: owner: <ruling>
- <id> <title>: withdrawn

Quorum: <prefixes> clear on revision N
