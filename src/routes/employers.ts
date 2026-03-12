import { Hono } from 'hono';
import type { Env, Variables, EmployerProfileRow, UpdateEmployerProfileBody } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const employers = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── GET /api/employers/profile ───────────────────────────────────────────────

employers.get('/profile', authMiddleware, requireRole('employer'), async (c) => {
  const userId = c.get('userId');

  const profile = await c.env.DB.prepare(
    'SELECT * FROM employer_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first<EmployerProfileRow>();

  if (!profile) {
    return c.json({ error: 'Not Found', message: 'Employer profile not found' }, 404);
  }

  // Fetch active job count as a subscription-adjacent metric
  const jobCountRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as active_jobs FROM jobs WHERE employer_id = ? AND status = 'active'"
  )
    .bind(userId)
    .first<{ active_jobs: number }>();

  return c.json({ data: { ...profile, active_jobs: jobCountRow?.active_jobs ?? 0 } });
});

// ─── PUT /api/employers/profile ───────────────────────────────────────────────

employers.put('/profile', authMiddleware, requireRole('employer'), async (c) => {
  let body: UpdateEmployerProfileBody;

  try {
    body = await c.req.json<UpdateEmployerProfileBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const userId = c.get('userId');

  const existing = await c.env.DB.prepare(
    'SELECT * FROM employer_profiles WHERE user_id = ?'
  )
    .bind(userId)
    .first<EmployerProfileRow>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Employer profile not found' }, 404);
  }

  if (body.website) {
    try {
      new URL(body.website);
    } catch {
      return c.json({ error: 'Bad Request', message: 'website must be a valid URL' }, 400);
    }
  }

  const updated = await c.env.DB.prepare(
    `UPDATE employer_profiles
     SET company_name = ?,
         company_logo = ?,
         industry = ?,
         description = ?,
         website = ?,
         updated_at = datetime('now')
     WHERE user_id = ?
     RETURNING *`
  )
    .bind(
      body.company_name ?? existing.company_name,
      body.company_logo !== undefined ? body.company_logo : existing.company_logo,
      body.industry !== undefined ? body.industry : existing.industry,
      body.description !== undefined ? body.description : existing.description,
      body.website !== undefined ? body.website : existing.website,
      userId
    )
    .first<EmployerProfileRow>();

  if (!updated) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to update profile' }, 500);
  }

  return c.json({ message: 'Employer profile updated successfully', data: updated });
});

// ─── GET /api/employers/:id/public (public employer profile with job listings) ─

employers.get('/:id/public', async (c) => {
  const employerId = parseInt(c.req.param('id'), 10);
  if (isNaN(employerId)) {
    return c.json({ error: 'Bad Request', message: 'Invalid employer ID' }, 400);
  }

  const profile = await c.env.DB.prepare(
    'SELECT * FROM employer_profiles WHERE user_id = ?'
  )
    .bind(employerId)
    .first<EmployerProfileRow>();

  if (!profile) {
    return c.json({ error: 'Not Found', message: 'Employer not found' }, 404);
  }

  const jobs = await c.env.DB.prepare(
    `SELECT id, title, category, location, salary_min, salary_max, employment_type, featured, created_at
     FROM jobs
     WHERE employer_id = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY featured DESC, created_at DESC
     LIMIT 20`
  )
    .bind(employerId)
    .all();

  return c.json({
    data: {
      ...profile,
      jobs: jobs.results ?? [],
    },
  });
});

export default employers;
