import { Hono } from 'hono';
import type {
  Env,
  Variables,
  ApplicationRow,
  JobRow,
  CreateApplicationBody,
  UpdateApplicationStatusBody,
  PaginatedResponse,
} from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const applications = new Hono<{ Bindings: Env; Variables: Variables }>();

const VALID_STATUSES = ['submitted', 'viewed', 'interview', 'hired', 'rejected'];

function parsePagination(page: string | undefined, limit: string | undefined) {
  const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

// ─── POST /api/applications (candidate applies to a job) ──────────────────────

applications.post('/', authMiddleware, requireRole('candidate'), async (c) => {
  let body: CreateApplicationBody;

  try {
    body = await c.req.json<CreateApplicationBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { job_id } = body;

  if (!job_id || isNaN(Number(job_id))) {
    return c.json({ error: 'Bad Request', message: 'job_id is required and must be a number' }, 400);
  }

  const candidateId = c.get('userId');

  // Verify the job exists and is active
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'active'")
    .bind(job_id)
    .first<JobRow>();

  if (!job) {
    return c.json({ error: 'Not Found', message: 'Job not found or is no longer accepting applications' }, 404);
  }

  // Prevent duplicate applications
  const existing = await c.env.DB.prepare(
    'SELECT id FROM applications WHERE job_id = ? AND candidate_id = ?'
  )
    .bind(job_id, candidateId)
    .first<{ id: number }>();

  if (existing) {
    return c.json({ error: 'Conflict', message: 'You have already applied to this job' }, 409);
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO applications (job_id, candidate_id, status)
     VALUES (?, ?, 'submitted')
     RETURNING *`
  )
    .bind(job_id, candidateId)
    .first<ApplicationRow>();

  if (!result) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to submit application' }, 500);
  }

  return c.json({ message: 'Application submitted successfully', data: result }, 201);
});

// ─── GET /api/applications ────────────────────────────────────────────────────
// Candidates see their own applications; employers see applications for their jobs.

applications.get('/', authMiddleware, requireRole('candidate', 'employer', 'admin'), async (c) => {
  const userId = c.get('userId');
  const role = c.get('userRole');
  const { page, limit, offset } = parsePagination(c.req.query('page'), c.req.query('limit'));
  const statusFilter = c.req.query('status') ?? '';

  let countQuery: string;
  let dataQuery: string;
  const params: (string | number)[] = [];

  const statusCondition =
    statusFilter && VALID_STATUSES.includes(statusFilter)
      ? 'AND a.status = ?'
      : '';
  if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
    params.push(statusFilter);
  }

  if (role === 'candidate') {
    const baseCondition = `FROM applications a JOIN jobs j ON j.id = a.job_id JOIN employer_profiles ep ON ep.user_id = j.employer_id WHERE a.candidate_id = ? ${statusCondition}`;
    countQuery = `SELECT COUNT(*) as total ${baseCondition}`;
    dataQuery = `SELECT a.*, j.title as job_title, j.location as job_location, j.employment_type, ep.company_name ${baseCondition} ORDER BY a.applied_at DESC LIMIT ? OFFSET ?`;
    params.unshift(userId);
  } else if (role === 'employer') {
    const baseCondition = `FROM applications a JOIN jobs j ON j.id = a.job_id JOIN candidate_profiles cp ON cp.user_id = a.candidate_id WHERE j.employer_id = ? ${statusCondition}`;
    countQuery = `SELECT COUNT(*) as total ${baseCondition}`;
    dataQuery = `SELECT a.*, j.title as job_title, cp.full_name as candidate_name ${baseCondition} ORDER BY a.applied_at DESC LIMIT ? OFFSET ?`;
    params.unshift(userId);
  } else {
    // admin sees all
    const baseCondition = `FROM applications a JOIN jobs j ON j.id = a.job_id JOIN candidate_profiles cp ON cp.user_id = a.candidate_id JOIN employer_profiles ep ON ep.user_id = j.employer_id WHERE 1=1 ${statusCondition}`;
    countQuery = `SELECT COUNT(*) as total ${baseCondition}`;
    dataQuery = `SELECT a.*, j.title as job_title, cp.full_name as candidate_name, ep.company_name ${baseCondition} ORDER BY a.applied_at DESC LIMIT ? OFFSET ?`;
  }

  const countRow = await c.env.DB.prepare(countQuery)
    .bind(...params)
    .first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(dataQuery)
    .bind(...params, limit, offset)
    .all<ApplicationRow>();

  const response: PaginatedResponse<ApplicationRow> = {
    data: rows.results ?? [],
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };

  return c.json(response);
});

// ─── PUT /api/applications/:id/status (employer updates status) ───────────────

applications.put('/:id/status', authMiddleware, requireRole('employer', 'admin'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid application ID' }, 400);
  }

  let body: UpdateApplicationStatusBody;
  try {
    body = await c.req.json<UpdateApplicationStatusBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { status } = body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return c.json(
      { error: 'Bad Request', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      400
    );
  }

  const userId = c.get('userId');
  const role = c.get('userRole');

  // Verify the application belongs to a job owned by this employer
  const application = await c.env.DB.prepare(
    `SELECT a.*, j.employer_id
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     WHERE a.id = ?`
  )
    .bind(id)
    .first<ApplicationRow & { employer_id: number }>();

  if (!application) {
    return c.json({ error: 'Not Found', message: 'Application not found' }, 404);
  }

  if (role !== 'admin' && application.employer_id !== userId) {
    return c.json({ error: 'Forbidden', message: 'You do not manage this application' }, 403);
  }

  const updated = await c.env.DB.prepare(
    'UPDATE applications SET status = ? WHERE id = ? RETURNING *'
  )
    .bind(status, id)
    .first<ApplicationRow>();

  if (!updated) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to update application status' }, 500);
  }

  return c.json({ message: 'Application status updated', data: updated });
});

export default applications;
