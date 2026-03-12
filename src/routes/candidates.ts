import { Hono } from 'hono';
import type { Env, Variables, CandidateProfileRow, UpdateCandidateProfileBody } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const candidates = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── GET /api/candidates/profile ──────────────────────────────────────────────

candidates.get('/profile', authMiddleware, requireRole('candidate'), async (c) => {
  const userId = c.get('userId');

  const profile = await c.env.DB.prepare(
    'SELECT * FROM candidate_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first<CandidateProfileRow>();

  if (!profile) {
    return c.json({ error: 'Not Found', message: 'Candidate profile not found' }, 404);
  }

  // Deserialize skills JSON array
  const skills: string[] = (() => {
    try {
      return profile.skills ? JSON.parse(profile.skills) : [];
    } catch {
      return [];
    }
  })();

  return c.json({ data: { ...profile, skills } });
});

// ─── PUT /api/candidates/profile ─────────────────────────────────────────────

candidates.put('/profile', authMiddleware, requireRole('candidate'), async (c) => {
  let body: UpdateCandidateProfileBody;

  try {
    body = await c.req.json<UpdateCandidateProfileBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const userId = c.get('userId');

  // Ensure profile exists
  const existing = await c.env.DB.prepare(
    'SELECT * FROM candidate_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first<CandidateProfileRow>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Candidate profile not found' }, 404);
  }

  if (body.experience_years !== undefined && (isNaN(body.experience_years) || body.experience_years < 0)) {
    return c.json({ error: 'Bad Request', message: 'experience_years must be a non-negative number' }, 400);
  }

  if (body.expected_salary !== undefined && (isNaN(body.expected_salary) || body.expected_salary < 0)) {
    return c.json({ error: 'Bad Request', message: 'expected_salary must be a non-negative number' }, 400);
  }

  const skillsJson =
    body.skills !== undefined
      ? JSON.stringify(body.skills)
      : existing.skills;

  const updated = await c.env.DB.prepare(
    `UPDATE candidate_profiles
     SET full_name = ?,
         phone = ?,
         location = ?,
         summary = ?,
         skills = ?,
         experience_years = ?,
         expected_salary = ?,
         updated_at = datetime('now')
     WHERE user_id = ?
     RETURNING *`
  )
    .bind(
      body.full_name ?? existing.full_name,
      body.phone !== undefined ? body.phone : existing.phone,
      body.location !== undefined ? body.location : existing.location,
      body.summary !== undefined ? body.summary : existing.summary,
      skillsJson,
      body.experience_years !== undefined ? body.experience_years : existing.experience_years,
      body.expected_salary !== undefined ? body.expected_salary : existing.expected_salary,
      userId
    )
    .first<CandidateProfileRow>();

  if (!updated) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to update profile' }, 500);
  }

  const skills: string[] = (() => {
    try {
      return updated.skills ? JSON.parse(updated.skills) : [];
    } catch {
      return [];
    }
  })();

  return c.json({ message: 'Profile updated successfully', data: { ...updated, skills } });
});

export default candidates;
