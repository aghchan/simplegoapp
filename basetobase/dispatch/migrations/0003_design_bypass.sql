-- The owner's design bypass (RunSnapshot.designBypassedAt) and the PRs a run's description says
-- it is a design for (coversOf, shared/src/design.ts), comma-joined, for the designs-owed list.
-- Both are NULL on a row indexed before them and for a run with neither; the version serving
-- before this one never writes them, which reads the same.
ALTER TABLE runs ADD COLUMN design_bypassed_at INTEGER;
ALTER TABLE runs ADD COLUMN covers TEXT;
