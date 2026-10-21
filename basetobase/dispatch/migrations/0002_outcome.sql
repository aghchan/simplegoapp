-- The review outcome (reviewOutcome, machine.ts). Rows indexed before it read back as pending.
ALTER TABLE runs ADD COLUMN outcome TEXT;
