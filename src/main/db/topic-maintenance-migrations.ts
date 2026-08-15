export const topicMaintenanceMigrations = [
  {
    version: 52,
    sql: `
      ALTER TABLE topic_maintenance_proposals ADD COLUMN stale_reason_json TEXT;
    `
  },
  {
    version: 53,
    sql: `
      ALTER TABLE topic_maintenance_proposals ADD COLUMN supersedes_proposal_id TEXT REFERENCES topic_maintenance_proposals(id);
      CREATE UNIQUE INDEX topic_maintenance_proposals_supersedes ON topic_maintenance_proposals(supersedes_proposal_id) WHERE supersedes_proposal_id IS NOT NULL;
      CREATE TABLE topic_maintenance_reproposal_jobs (
        proposal_id TEXT PRIMARY KEY REFERENCES topic_maintenance_proposals(id),
        job_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending','completed','needs_user')),
        conflict_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        due_at TEXT NOT NULL,
        last_error TEXT,
        successor_proposal_id TEXT UNIQUE REFERENCES topic_maintenance_proposals(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX topic_maintenance_reproposal_due ON topic_maintenance_reproposal_jobs(status,due_at);
    `
  }
] as const;
