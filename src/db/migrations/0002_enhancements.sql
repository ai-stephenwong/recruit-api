-- Migration: 0002_enhancements
-- Description: Add saved_jobs, job_alerts tables; extend jobs and applications

-- ─── Saved Jobs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  saved_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_candidate ON saved_jobs(candidate_id);

-- ─── Job Alerts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keywords         TEXT,
  category         TEXT,
  location         TEXT,
  employment_type  TEXT,
  salary_min       INTEGER,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_alerts_candidate ON job_alerts(candidate_id);

-- ─── Extend applications with pipeline stage and notes ────────────────────────
ALTER TABLE applications ADD COLUMN pipeline_stage TEXT DEFAULT 'new'
  CHECK(pipeline_stage IN ('new','reviewed','interview','hired','rejected'));
ALTER TABLE applications ADD COLUMN recruiter_notes TEXT;
ALTER TABLE applications ADD COLUMN cover_letter TEXT;
