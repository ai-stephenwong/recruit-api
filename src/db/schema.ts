/**
 * Recruit.com.hk — D1 Database Schema
 *
 * This file documents the canonical table definitions.
 * The actual CREATE TABLE statements live in the SQL migration file.
 * This TypeScript file is kept for documentation and type-safety reference.
 */

export const SCHEMA_VERSION = '0001';

export const TABLE_NAMES = {
  USERS: 'users',
  CANDIDATE_PROFILES: 'candidate_profiles',
  EMPLOYER_PROFILES: 'employer_profiles',
  JOBS: 'jobs',
  APPLICATIONS: 'applications',
  CONTENT_ARTICLES: 'content_articles',
} as const;

/**
 * Initialise the database with the complete schema.
 * Used in tests and local dev when running without the migration runner.
 */
export async function initSchema(db: D1Database): Promise<void> {
  const statements = getSchemaStatements();
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

export function getSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK(role IN ('candidate','employer','admin')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS candidate_profiles (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name        TEXT    NOT NULL,
      phone            TEXT,
      location         TEXT,
      summary          TEXT,
      skills           TEXT,   -- JSON array
      experience_years INTEGER,
      expected_salary  INTEGER,
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS employer_profiles (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      company_name TEXT    NOT NULL,
      company_logo TEXT,
      industry     TEXT,
      description  TEXT,
      website      TEXT,
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      employer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT    NOT NULL,
      description     TEXT    NOT NULL,
      category        TEXT    NOT NULL,
      location        TEXT    NOT NULL,
      salary_min      INTEGER,
      salary_max      INTEGER,
      employment_type TEXT    NOT NULL CHECK(employment_type IN ('full-time','part-time','contract','internship','temporary')),
      status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed','draft')),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT,
      featured        INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE TABLE IF NOT EXISTS applications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT    NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','viewed','interview','hired','rejected')),
      applied_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(job_id, candidate_id)
    )`,

    `CREATE TABLE IF NOT EXISTS content_articles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      slug         TEXT NOT NULL UNIQUE,
      body         TEXT NOT NULL,
      author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status       TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
      published_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    // Indexes for common query patterns
    `CREATE INDEX IF NOT EXISTS idx_jobs_employer_id ON jobs(employer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs(category)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_featured ON jobs(featured)`,
    `CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_applications_candidate_id ON applications(candidate_id)`,
    `CREATE INDEX IF NOT EXISTS idx_articles_slug ON content_articles(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_articles_status ON content_articles(status)`,
  ];
}
