-- Recruit.com.hk — Initial Database Migration
-- Migration: 0001_init
-- Description: Create all core tables and indexes

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('candidate', 'employer', 'admin')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Candidate Profiles ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candidate_profiles (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name        TEXT    NOT NULL,
  phone            TEXT,
  location         TEXT,
  summary          TEXT,
  skills           TEXT,   -- Stored as a JSON array string, e.g. '["Python","SQL"]'
  experience_years INTEGER,
  expected_salary  INTEGER, -- Monthly salary in HKD
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Employer Profiles ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employer_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT    NOT NULL,
  company_logo TEXT,   -- URL to logo image
  industry     TEXT,
  description  TEXT,
  website      TEXT,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Job Listings ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  location        TEXT    NOT NULL,
  salary_min      INTEGER,  -- Monthly salary in HKD
  salary_max      INTEGER,  -- Monthly salary in HKD
  employment_type TEXT    NOT NULL CHECK(employment_type IN ('full-time', 'part-time', 'contract', 'internship', 'temporary')),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'draft')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT,   -- ISO-8601 datetime; NULL means no expiry
  featured        INTEGER NOT NULL DEFAULT 0  -- Boolean: 1 = featured, 0 = standard
);

-- ─── Job Applications ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'submitted'
                 CHECK(status IN ('submitted', 'viewed', 'interview', 'hired', 'rejected')),
  applied_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, candidate_id)
);

-- ─── Content Articles ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS content_articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  slug         TEXT    NOT NULL UNIQUE,
  body         TEXT    NOT NULL,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
  published_at TEXT,   -- ISO-8601 datetime; NULL while in draft
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_jobs_employer_id   ON jobs(employer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_category      ON jobs(category);
CREATE INDEX IF NOT EXISTS idx_jobs_location      ON jobs(location);
CREATE INDEX IF NOT EXISTS idx_jobs_featured      ON jobs(featured);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at    ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at    ON jobs(expires_at);

CREATE INDEX IF NOT EXISTS idx_applications_job_id       ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_candidate_id ON applications(candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_status       ON applications(status);

CREATE INDEX IF NOT EXISTS idx_articles_slug      ON content_articles(slug);
CREATE INDEX IF NOT EXISTS idx_articles_status    ON content_articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_published ON content_articles(published_at);

-- ─── Seed: Default Admin User ─────────────────────────────────────────────────
-- Password: Admin@1234  (SHA-256 hash)
-- IMPORTANT: Change the password immediately after first login.

INSERT OR IGNORE INTO users (email, password_hash, role)
VALUES (
  'admin@recruit.com.hk',
  'a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4',
  'admin'
);
