CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, pr_title TEXT NOT NULL,
  head_sha TEXT NOT NULL, run_name TEXT NOT NULL, rating TEXT NOT NULL, status TEXT NOT NULL,
  current_step TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX runs_status ON runs(status, updated_at);
CREATE INDEX runs_pr ON runs(repo, pr_number);
