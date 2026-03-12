import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const saved = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/saved — list saved jobs for current candidate
saved.get('/', authMiddleware, requireRole('candidate'), async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(`
    SELECT j.*, ep.company_name, ep.company_logo, ep.industry
    FROM saved_jobs sj
    JOIN jobs j ON j.id = sj.job_id
    LEFT JOIN employer_profiles ep ON ep.user_id = j.employer_id
    WHERE sj.candidate_id = ?
    ORDER BY sj.saved_at DESC
  `).bind(userId).all();
  return c.json({ data: results });
});

// POST /api/saved/:jobId — save a job
saved.post('/:jobId', authMiddleware, requireRole('candidate'), async (c) => {
  const userId = c.get('userId');
  const jobId = Number(c.req.param('jobId'));
  try {
    await c.env.DB.prepare(
      'INSERT INTO saved_jobs (candidate_id, job_id) VALUES (?, ?)'
    ).bind(userId, jobId).run();
    return c.json({ message: 'Job saved' }, 201);
  } catch {
    return c.json({ error: 'Already saved' }, 409);
  }
});

// DELETE /api/saved/:jobId — unsave a job
saved.delete('/:jobId', authMiddleware, requireRole('candidate'), async (c) => {
  const userId = c.get('userId');
  const jobId = Number(c.req.param('jobId'));
  await c.env.DB.prepare(
    'DELETE FROM saved_jobs WHERE candidate_id = ? AND job_id = ?'
  ).bind(userId, jobId).run();
  return c.json({ message: 'Job unsaved' });
});

// GET /api/saved/ids — return list of saved job IDs for current user
saved.get('/ids', authMiddleware, requireRole('candidate'), async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT job_id FROM saved_jobs WHERE candidate_id = ?'
  ).bind(userId).all<{ job_id: number }>();
  return c.json({ data: results.map(r => r.job_id) });
});

export default saved;
