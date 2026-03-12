import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { authMiddleware, roleGuard } from '../middleware/auth';

const alerts = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/alerts
alerts.get('/', authMiddleware, roleGuard('candidate'), async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM job_alerts WHERE candidate_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return c.json({ data: results });
});

// POST /api/alerts
alerts.post('/', authMiddleware, roleGuard('candidate'), async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { keywords, category, location, employment_type, salary_min } = body;
  const result = await c.env.DB.prepare(
    'INSERT INTO job_alerts (candidate_id, keywords, category, location, employment_type, salary_min) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(userId, keywords || null, category || null, location || null, employment_type || null, salary_min || null)
   .first();
  return c.json({ data: result }, 201);
});

// DELETE /api/alerts/:id
alerts.delete('/:id', authMiddleware, roleGuard('candidate'), async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare(
    'DELETE FROM job_alerts WHERE id = ? AND candidate_id = ?'
  ).bind(id, userId).run();
  return c.json({ message: 'Alert deleted' });
});

export default alerts;
