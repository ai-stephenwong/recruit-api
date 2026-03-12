import { Hono } from 'hono';
import type {
  Env,
  Variables,
  JobRow,
  CreateJobBody,
  UpdateJobBody,
  PaginatedResponse,
} from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const jobs = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePagination(page: string | undefined, limit: string | undefined) {
  const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function mapJobRow(row: JobRow) {
  return { ...row, featured: row.featured === 1 };
}

const VALID_EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'internship', 'temporary'];
const VALID_STATUSES = ['active', 'closed', 'draft'];

// ─── GET /api/jobs/featured ───────────────────────────────────────────────────
// Note: must be defined before /:id to avoid route shadowing

jobs.get('/featured', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name, ep.company_logo
     FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE j.featured = 1 AND j.status = 'active'
       AND (j.expires_at IS NULL OR j.expires_at > datetime('now'))
     ORDER BY j.created_at DESC
     LIMIT 20`
  ).all<JobRow & { company_name: string; company_logo: string | null }>();

  return c.json({ data: (rows.results ?? []).map(mapJobRow) });
});

// ─── GET /api/jobs ────────────────────────────────────────────────────────────

jobs.get('/', async (c) => {
  const { page, limit, offset } = parsePagination(
    c.req.query('page'),
    c.req.query('limit')
  );

  const search = c.req.query('search') ?? '';
  const category = c.req.query('category') ?? '';
  const location = c.req.query('location') ?? '';
  const employmentType = c.req.query('employment_type') ?? '';
  const salaryMin = c.req.query('salary_min');
  const salaryMax = c.req.query('salary_max');
  const featured = c.req.query('featured');

  const conditions: string[] = ["j.status = 'active'", "(j.expires_at IS NULL OR j.expires_at > datetime('now'))"];
  const params: (string | number)[] = [];

  if (search) {
    conditions.push('(j.title LIKE ? OR j.description LIKE ? OR ep.company_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (category) {
    conditions.push('j.category = ?');
    params.push(category);
  }

  if (location) {
    conditions.push('j.location LIKE ?');
    params.push(`%${location}%`);
  }

  if (employmentType && VALID_EMPLOYMENT_TYPES.includes(employmentType)) {
    conditions.push('j.employment_type = ?');
    params.push(employmentType);
  }

  if (salaryMin) {
    const min = parseInt(salaryMin, 10);
    if (!isNaN(min)) {
      conditions.push('(j.salary_max IS NULL OR j.salary_max >= ?)');
      params.push(min);
    }
  }

  if (salaryMax) {
    const max = parseInt(salaryMax, 10);
    if (!isNaN(max)) {
      conditions.push('(j.salary_min IS NULL OR j.salary_min <= ?)');
      params.push(max);
    }
  }

  if (featured === '1' || featured === 'true') {
    conditions.push('j.featured = 1');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total
     FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     ${where}`
  )
    .bind(...params)
    .first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name, ep.company_logo, ep.industry
     FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     ${where}
     ORDER BY j.featured DESC, j.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<JobRow & { company_name: string; company_logo: string | null; industry: string | null }>();

  const response: PaginatedResponse<ReturnType<typeof mapJobRow>> = {
    data: (rows.results ?? []).map(mapJobRow),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };

  return c.json(response);
});

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────

jobs.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid job ID' }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name, ep.company_logo, ep.industry, ep.website, ep.description as company_description
     FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE j.id = ?`
  )
    .bind(id)
    .first<JobRow & {
      company_name: string;
      company_logo: string | null;
      industry: string | null;
      website: string | null;
      company_description: string | null;
    }>();

  if (!row) {
    return c.json({ error: 'Not Found', message: 'Job not found' }, 404);
  }

  return c.json({ data: mapJobRow(row) });
});

// ─── POST /api/jobs (employer only) ──────────────────────────────────────────

jobs.post('/', authMiddleware, requireRole('employer', 'admin'), async (c) => {
  let body: CreateJobBody;

  try {
    body = await c.req.json<CreateJobBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { title, description, category, location, employment_type, status = 'active' } = body;

  if (!title || !description || !category || !location || !employment_type) {
    return c.json(
      { error: 'Bad Request', message: 'title, description, category, location, and employment_type are required' },
      400
    );
  }

  if (!VALID_EMPLOYMENT_TYPES.includes(employment_type)) {
    return c.json(
      { error: 'Bad Request', message: `employment_type must be one of: ${VALID_EMPLOYMENT_TYPES.join(', ')}` },
      400
    );
  }

  if (!VALID_STATUSES.includes(status)) {
    return c.json(
      { error: 'Bad Request', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      400
    );
  }

  const employerId = c.get('userId');

  const result = await c.env.DB.prepare(
    `INSERT INTO jobs (employer_id, title, description, category, location, salary_min, salary_max, employment_type, status, expires_at, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(
      employerId,
      title,
      description,
      category,
      location,
      body.salary_min ?? null,
      body.salary_max ?? null,
      employment_type,
      status,
      body.expires_at ?? null,
      body.featured ? 1 : 0
    )
    .first<JobRow>();

  if (!result) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to create job' }, 500);
  }

  return c.json({ message: 'Job created successfully', data: mapJobRow(result) }, 201);
});

// ─── PUT /api/jobs/:id (employer only) ───────────────────────────────────────

jobs.put('/:id', authMiddleware, requireRole('employer', 'admin'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid job ID' }, 400);
  }

  let body: UpdateJobBody;
  try {
    body = await c.req.json<UpdateJobBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const userId = c.get('userId');
  const role = c.get('userRole');

  const existing = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(id)
    .first<JobRow>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Job not found' }, 404);
  }

  if (role !== 'admin' && existing.employer_id !== userId) {
    return c.json({ error: 'Forbidden', message: 'You do not own this job listing' }, 403);
  }

  if (body.employment_type && !VALID_EMPLOYMENT_TYPES.includes(body.employment_type)) {
    return c.json(
      { error: 'Bad Request', message: `employment_type must be one of: ${VALID_EMPLOYMENT_TYPES.join(', ')}` },
      400
    );
  }

  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return c.json(
      { error: 'Bad Request', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      400
    );
  }

  const updated = await c.env.DB.prepare(
    `UPDATE jobs
     SET title = ?,
         description = ?,
         category = ?,
         location = ?,
         salary_min = ?,
         salary_max = ?,
         employment_type = ?,
         status = ?,
         expires_at = ?,
         featured = ?
     WHERE id = ?
     RETURNING *`
  )
    .bind(
      body.title ?? existing.title,
      body.description ?? existing.description,
      body.category ?? existing.category,
      body.location ?? existing.location,
      body.salary_min !== undefined ? body.salary_min : existing.salary_min,
      body.salary_max !== undefined ? body.salary_max : existing.salary_max,
      body.employment_type ?? existing.employment_type,
      body.status ?? existing.status,
      body.expires_at !== undefined ? body.expires_at : existing.expires_at,
      body.featured !== undefined ? (body.featured ? 1 : 0) : existing.featured,
      id
    )
    .first<JobRow>();

  if (!updated) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to update job' }, 500);
  }

  return c.json({ message: 'Job updated successfully', data: mapJobRow(updated) });
});

// ─── DELETE /api/jobs/:id (employer only) ─────────────────────────────────────

jobs.delete('/:id', authMiddleware, requireRole('employer', 'admin'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid job ID' }, 400);
  }

  const userId = c.get('userId');
  const role = c.get('userRole');

  const existing = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(id)
    .first<JobRow>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Job not found' }, 404);
  }

  if (role !== 'admin' && existing.employer_id !== userId) {
    return c.json({ error: 'Forbidden', message: 'You do not own this job listing' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();

  return c.json({ message: 'Job deleted successfully' });
});

export default jobs;
