import { Hono } from 'hono';
import type { Env, Variables, UserRow, JobRow, ArticleRow, CreateArticleBody } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// All admin routes require authentication and admin role
admin.use('*', authMiddleware, requireRole('admin'));

function parsePagination(page: string | undefined, limit: string | undefined) {
  const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

// ─── GET /api/admin/jobs ──────────────────────────────────────────────────────

admin.get('/jobs', async (c) => {
  const { page, limit, offset } = parsePagination(c.req.query('page'), c.req.query('limit'));
  const status = c.req.query('status') ?? '';
  const search = c.req.query('q') ?? c.req.query('search') ?? '';

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push('j.status = ?');
    params.push(status);
  }

  if (search) {
    conditions.push('(j.title LIKE ? OR ep.company_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM jobs j JOIN employer_profiles ep ON ep.user_id = j.employer_id ${where}`
  )
    .bind(...params)
    .first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name
     FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     ${where}
     ORDER BY j.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<JobRow & { company_name: string }>();

  return c.json({
    data: rows.results ?? [],
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

admin.get('/users', async (c) => {
  const { page, limit, offset } = parsePagination(c.req.query('page'), c.req.query('limit'));
  const role = c.req.query('role') ?? '';
  const search = c.req.query('q') ?? c.req.query('search') ?? '';

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (role && ['candidate', 'employer', 'admin'].includes(role)) {
    conditions.push('role = ?');
    params.push(role);
  }

  if (search) {
    conditions.push('email LIKE ?');
    params.push(`%${search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM users ${where}`)
    .bind(...params)
    .first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, email, role, created_at FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<Pick<UserRow, 'id' | 'email' | 'role' | 'created_at'>>();

  return c.json({
    data: rows.results ?? [],
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

// ─── GET /api/admin/analytics ─────────────────────────────────────────────────

admin.get('/analytics', async (c) => {
  const [users, jobs, applications, candidates, employers, activeJobs, publishedArticles] =
    await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM jobs').first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM applications').first<{ count: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'candidate'").first<{ count: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'employer'").first<{ count: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'active'").first<{ count: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as count FROM content_articles WHERE status = 'published'").first<{ count: number }>(),
    ]);

  // Applications per status breakdown
  const appsByStatus = await c.env.DB.prepare(
    'SELECT status, COUNT(*) as count FROM applications GROUP BY status'
  ).all<{ status: string; count: number }>();

  // Jobs created in the last 30 days
  const recentJobs = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM jobs WHERE created_at >= datetime('now', '-30 days')"
  ).first<{ count: number }>();

  return c.json({
    data: {
      totals: {
        users: users?.count ?? 0,
        candidates: candidates?.count ?? 0,
        employers: employers?.count ?? 0,
        jobs: jobs?.count ?? 0,
        active_jobs: activeJobs?.count ?? 0,
        applications: applications?.count ?? 0,
        published_articles: publishedArticles?.count ?? 0,
      },
      applications_by_status: appsByStatus.results ?? [],
      jobs_last_30_days: recentJobs?.count ?? 0,
    },
  });
});

// ─── GET /api/admin/articles ──────────────────────────────────────────────────

admin.get('/articles', async (c) => {
  const { page, limit, offset } = parsePagination(c.req.query('page'), c.req.query('limit'));

  const countRow = await c.env.DB.prepare('SELECT COUNT(*) as total FROM content_articles')
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT ca.*, u.email as author_email
     FROM content_articles ca
     JOIN users u ON u.id = ca.author_id
     ORDER BY ca.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<ArticleRow & { author_email: string }>();

  return c.json({
    data: rows.results ?? [],
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

// ─── PUT /api/admin/jobs/:id/status ───────────────────────────────────────────

admin.put('/jobs/:id/status', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid job ID' }, 400);
  }

  let body: { status: string };
  try {
    body = await c.req.json<{ status: string }>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  if (!['active', 'closed', 'draft'].includes(body.status)) {
    return c.json({ error: 'Bad Request', message: 'status must be active, closed, or draft' }, 400);
  }

  const updated = await c.env.DB.prepare(
    'UPDATE jobs SET status = ? WHERE id = ? RETURNING *'
  )
    .bind(body.status, id)
    .first<JobRow>();

  if (!updated) {
    return c.json({ error: 'Not Found', message: 'Job not found' }, 404);
  }

  return c.json({ message: 'Job status updated', data: updated });
});

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────

admin.delete('/users/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid user ID' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();

  if (!user) {
    return c.json({ error: 'Not Found', message: 'User not found' }, 404);
  }

  // Cascade: delete profile, jobs, applications
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM candidate_profiles WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM employer_profiles WHERE user_id = ?').bind(id),
    c.env.DB.prepare(
      'DELETE FROM applications WHERE candidate_id = ? OR job_id IN (SELECT id FROM jobs WHERE employer_id = ?)'
    ).bind(id, id),
    c.env.DB.prepare('DELETE FROM jobs WHERE employer_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);

  return c.json({ message: 'User and all associated data deleted successfully' });
});

export default admin;
