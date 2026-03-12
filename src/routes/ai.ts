/**
 * AI Routes — Recruit.com.hk
 *
 * POST /api/ai/embed/job/:id          — generate/refresh embedding for a job
 * POST /api/ai/embed/candidate/:id    — generate/refresh embedding for a candidate
 * GET  /api/ai/match/jobs             — AI job recommendations for authenticated candidate
 * GET  /api/ai/match/candidates/:id   — AI candidate matches for a job (employer)
 * POST /api/ai/cv/parse               — parse raw CV text and return structured data
 * POST /api/chatbot/sessions          — start a new chatbot session
 * POST /api/chatbot/sessions/:id      — send a message and get a reply
 * GET  /api/chatbot/sessions/:id      — get message history for a session
 */

import { Hono } from 'hono';
import type { Env, Variables, JobRow, CandidateProfileRow, AiEmbeddingRow } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';
import {
  createOpenAIClient,
  generateEmbedding,
  jobToText,
  candidateToText,
  cosineSimilarity,
  hybridMatchScore,
  parseCvText,
  classifyIntent,
  chatReply,
} from '../lib/openai';

const ai = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  // Simple UUID v4 compatible with Cloudflare Workers
  return crypto.randomUUID();
}

async function getOrCreateEmbedding(
  db: D1Database,
  client: ReturnType<typeof createOpenAIClient>,
  entityType: 'job' | 'candidate',
  entityId: number,
  getText: () => Promise<string | null>
): Promise<number[] | null> {
  // Check cache
  const cached = await db
    .prepare('SELECT embedding FROM ai_embeddings WHERE entity_type = ? AND entity_id = ?')
    .bind(entityType, entityId)
    .first<Pick<AiEmbeddingRow, 'embedding'>>();

  if (cached) {
    return JSON.parse(cached.embedding) as number[];
  }

  // Generate fresh
  const text = await getText();
  if (!text) return null;

  const vector = await generateEmbedding(client, text);

  await db
    .prepare(
      `INSERT INTO ai_embeddings (entity_type, entity_id, embedding, model)
       VALUES (?, ?, ?, 'text-embedding-3-small')
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         embedding = excluded.embedding,
         updated_at = datetime('now')`
    )
    .bind(entityType, entityId, JSON.stringify(vector))
    .run();

  return vector;
}

// ─── POST /embed/job/:id ──────────────────────────────────────────────────────

ai.post('/embed/job/:id', authMiddleware, requireRole('admin'), async (c) => {
  const jobId = parseInt(c.req.param('id'), 10);
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);

  const job = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE j.id = ?`
  )
    .bind(jobId)
    .first<JobRow & { company_name: string }>();

  if (!job) return c.json({ error: 'Not Found', message: 'Job not found' }, 404);

  const text = jobToText(job);
  const vector = await generateEmbedding(client, text);

  await c.env.DB.prepare(
    `INSERT INTO ai_embeddings (entity_type, entity_id, embedding, model)
     VALUES ('job', ?, ?, 'text-embedding-3-small')
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       embedding = excluded.embedding,
       updated_at = datetime('now')`
  )
    .bind(jobId, JSON.stringify(vector))
    .run();

  return c.json({ message: 'Embedding generated', job_id: jobId });
});

// ─── POST /embed/candidate/:id ────────────────────────────────────────────────

ai.post('/embed/candidate/:id', authMiddleware, requireRole('admin'), async (c) => {
  const candidateId = parseInt(c.req.param('id'), 10);
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);

  const profile = await c.env.DB.prepare('SELECT * FROM candidate_profiles WHERE user_id = ?')
    .bind(candidateId)
    .first<CandidateProfileRow>();

  if (!profile) return c.json({ error: 'Not Found', message: 'Candidate not found' }, 404);

  const text = candidateToText(profile);
  const vector = await generateEmbedding(client, text);

  await c.env.DB.prepare(
    `INSERT INTO ai_embeddings (entity_type, entity_id, embedding, model)
     VALUES ('candidate', ?, ?, 'text-embedding-3-small')
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       embedding = excluded.embedding,
       updated_at = datetime('now')`
  )
    .bind(candidateId, JSON.stringify(vector))
    .run();

  return c.json({ message: 'Embedding generated', candidate_id: candidateId });
});

// ─── GET /match/jobs — AI job recommendations for a candidate ─────────────────

ai.get('/match/jobs', authMiddleware, requireRole('candidate'), async (c) => {
  const candidateId = c.get('userId');
  const limit = Math.min(20, parseInt(c.req.query('limit') ?? '10', 10) || 10);
  const threshold = parseFloat(c.req.query('threshold') ?? '0.5');
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);

  // Get candidate profile + embedding
  const profile = await c.env.DB.prepare('SELECT * FROM candidate_profiles WHERE user_id = ?')
    .bind(candidateId)
    .first<CandidateProfileRow>();

  if (!profile) return c.json({ error: 'Not Found', message: 'Candidate profile not found' }, 404);

  const candidateVector = await getOrCreateEmbedding(
    c.env.DB,
    client,
    'candidate',
    candidateId,
    async () => candidateToText(profile)
  );

  if (!candidateVector) return c.json({ data: [], message: 'Could not generate candidate embedding' });

  // Fetch all active job embeddings
  const jobEmbeddings = await c.env.DB.prepare(
    `SELECT ae.entity_id, ae.embedding,
            j.title, j.category, j.location, j.employment_type, j.salary_min, j.salary_max,
            ep.company_name
     FROM ai_embeddings ae
     JOIN jobs j ON j.id = ae.entity_id
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE ae.entity_type = 'job'
       AND j.status = 'active'
       AND (j.expires_at IS NULL OR j.expires_at > datetime('now'))`
  ).all<{
    entity_id: number;
    embedding: string;
    title: string;
    category: string;
    location: string;
    employment_type: string;
    salary_min: number | null;
    salary_max: number | null;
    company_name: string;
  }>();

  const rows = jobEmbeddings.results ?? [];

  // Compute hybrid scores
  const scored = rows
    .map((row) => {
      const jobVector: number[] = JSON.parse(row.embedding);
      const vectorScore = cosineSimilarity(candidateVector, jobVector);

      const score = hybridMatchScore(vectorScore, {
        locationMatch: profile.location
          ? row.location.toLowerCase().includes(profile.location.toLowerCase())
          : false,
        salaryInRange:
          profile.expected_salary !== null && row.salary_max !== null
            ? profile.expected_salary <= row.salary_max
            : false,
        employmentTypeMatch: false, // candidate preferred types not in schema yet
      });

      return {
        job_id: row.entity_id,
        title: row.title,
        company_name: row.company_name,
        category: row.category,
        location: row.location,
        employment_type: row.employment_type,
        salary_min: row.salary_min,
        salary_max: row.salary_max,
        match_score: Math.round(score * 100) / 100,
        vector_score: Math.round(vectorScore * 100) / 100,
      };
    })
    .filter((r) => r.match_score >= threshold)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, limit);

  return c.json({ data: scored, total: scored.length });
});

// ─── GET /match/candidates/:id — AI candidates for a job (employer) ───────────

ai.get('/match/candidates/:id', authMiddleware, requireRole('employer'), async (c) => {
  const jobId = parseInt(c.req.param('id'), 10);
  const limit = Math.min(20, parseInt(c.req.query('limit') ?? '10', 10) || 10);
  const threshold = parseFloat(c.req.query('threshold') ?? '0.5');
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);
  const employerId = c.get('userId');

  // Verify the employer owns this job
  const job = await c.env.DB.prepare(
    `SELECT j.*, ep.company_name FROM jobs j
     JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE j.id = ? AND j.employer_id = ?`
  )
    .bind(jobId, employerId)
    .first<JobRow & { company_name: string }>();

  if (!job) return c.json({ error: 'Not Found', message: 'Job not found' }, 404);

  const jobVector = await getOrCreateEmbedding(
    c.env.DB,
    client,
    'job',
    jobId,
    async () => jobToText(job)
  );

  if (!jobVector) return c.json({ data: [], message: 'Could not generate job embedding' });

  // Fetch all candidate embeddings
  const candidateEmbeddings = await c.env.DB.prepare(
    `SELECT ae.entity_id, ae.embedding,
            cp.full_name, cp.location, cp.skills, cp.experience_years, cp.expected_salary,
            u.email
     FROM ai_embeddings ae
     JOIN candidate_profiles cp ON cp.user_id = ae.entity_id
     JOIN users u ON u.id = ae.entity_id
     WHERE ae.entity_type = 'candidate'`
  ).all<{
    entity_id: number;
    embedding: string;
    full_name: string;
    location: string | null;
    skills: string | null;
    experience_years: number | null;
    expected_salary: number | null;
    email: string;
  }>();

  const rows = candidateEmbeddings.results ?? [];

  const scored = rows
    .map((row) => {
      const candidateVector: number[] = JSON.parse(row.embedding);
      const vectorScore = cosineSimilarity(jobVector, candidateVector);

      const score = hybridMatchScore(vectorScore, {
        locationMatch: row.location
          ? job.location.toLowerCase().includes(row.location.toLowerCase())
          : false,
        salaryInRange:
          row.expected_salary !== null && job.salary_max !== null
            ? row.expected_salary <= job.salary_max
            : false,
        employmentTypeMatch: false,
      });

      return {
        candidate_id: row.entity_id,
        full_name: row.full_name,
        email: row.email,
        location: row.location,
        experience_years: row.experience_years,
        expected_salary: row.expected_salary,
        skills: row.skills ? (JSON.parse(row.skills) as string[]) : [],
        match_score: Math.round(score * 100) / 100,
        vector_score: Math.round(vectorScore * 100) / 100,
      };
    })
    .filter((r) => r.match_score >= threshold)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, limit);

  return c.json({ data: scored, total: scored.length });
});

// ─── POST /cv/parse — Parse raw CV text ───────────────────────────────────────

ai.post('/cv/parse', authMiddleware, requireRole('candidate'), async (c) => {
  const candidateId = c.get('userId');
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);

  let body: { text: string };
  try {
    body = await c.req.json<{ text: string }>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  if (!body.text || body.text.trim().length < 50) {
    return c.json({ error: 'Bad Request', message: 'CV text must be at least 50 characters' }, 400);
  }

  const parsed = await parseCvText(client, body.text);

  // Persist raw text + parsed JSON
  await c.env.DB.prepare(
    `INSERT INTO cv_parsed_data (candidate_id, raw_text, parsed_json)
     VALUES (?, ?, ?)
     ON CONFLICT(candidate_id) DO UPDATE SET
       raw_text = excluded.raw_text,
       parsed_json = excluded.parsed_json,
       parsed_at = datetime('now')`
  )
    .bind(candidateId, body.text.slice(0, 50000), JSON.stringify(parsed))
    .run();

  // Auto-update candidate profile if fields are missing
  const profile = await c.env.DB.prepare(
    'SELECT * FROM candidate_profiles WHERE user_id = ?'
  )
    .bind(candidateId)
    .first<{ full_name: string; summary: string | null; skills: string | null; experience_years: number | null }>();

  if (profile) {
    await c.env.DB.prepare(
      `UPDATE candidate_profiles SET
         full_name        = COALESCE(NULLIF(full_name, ''), ?),
         summary          = COALESCE(summary, ?),
         skills           = COALESCE(skills, ?),
         experience_years = COALESCE(experience_years, ?),
         location         = COALESCE(location, ?),
         updated_at       = datetime('now')
       WHERE user_id = ?`
    )
      .bind(
        parsed.full_name ?? profile.full_name,
        parsed.summary ?? null,
        parsed.skills.length ? JSON.stringify(parsed.skills) : null,
        parsed.experience_years ?? null,
        parsed.location ?? null,
        candidateId
      )
      .run();

    // Regenerate embedding after profile update
    const updatedProfile = await c.env.DB.prepare(
      'SELECT * FROM candidate_profiles WHERE user_id = ?'
    )
      .bind(candidateId)
      .first<{ full_name: string; summary: string | null; skills: string | null; experience_years: number | null; expected_salary: number | null; location: string | null }>();

    if (updatedProfile) {
      const text = candidateToText(updatedProfile);
      const vector = await generateEmbedding(client, text);
      await c.env.DB.prepare(
        `INSERT INTO ai_embeddings (entity_type, entity_id, embedding, model)
         VALUES ('candidate', ?, ?, 'text-embedding-3-small')
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           embedding = excluded.embedding, updated_at = datetime('now')`
      )
        .bind(candidateId, JSON.stringify(vector))
        .run();
    }
  }

  return c.json({
    message: 'CV parsed successfully',
    parsed,
    profile_updated: true,
  });
});

// ─── Chatbot ──────────────────────────────────────────────────────────────────

// POST /chatbot/sessions — start a new session
ai.post('/chatbot/sessions', async (c) => {
  // Optional auth — works for anonymous users too
  let userId: number | null = null;
  let userType: 'candidate' | 'employer' | 'anonymous' = 'anonymous';

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(c.env.JWT_SECRET);
      const { payload } = await jwtVerify(authHeader.slice(7), secret);
      userId = parseInt(payload.sub as string, 10);
      userType = (payload as { role: string }).role as 'candidate' | 'employer';
    } catch {
      // ignore invalid token — treat as anonymous
    }
  }

  const sessionId = generateSessionId();

  await c.env.DB.prepare(
    'INSERT INTO chatbot_sessions (id, user_id, user_type) VALUES (?, ?, ?)'
  )
    .bind(sessionId, userId, userType)
    .run();

  return c.json({ session_id: sessionId, user_type: userType }, 201);
});

// POST /chatbot/sessions/:id — send a message
ai.post('/chatbot/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const client = createOpenAIClient(c.env.OPENAI_API_KEY);

  let body: { message: string };
  try {
    body = await c.req.json<{ message: string }>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  if (!body.message?.trim()) {
    return c.json({ error: 'Bad Request', message: 'message is required' }, 400);
  }

  // Verify session exists
  const session = await c.env.DB.prepare(
    'SELECT * FROM chatbot_sessions WHERE id = ?'
  )
    .bind(sessionId)
    .first<{ id: string; user_id: number | null; user_type: string }>();

  if (!session) return c.json({ error: 'Not Found', message: 'Session not found' }, 404);

  // Fetch message history (last 20)
  const historyRows = await c.env.DB.prepare(
    `SELECT role, content FROM chatbot_messages
     WHERE session_id = ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(sessionId)
    .all<{ role: 'user' | 'assistant'; content: string }>();

  const history = (historyRows.results ?? []).reverse();

  // Classify intent
  const intent = await classifyIntent(client, body.message);

  // Build context for job_search intent
  let context: string | undefined;
  if (intent === 'job_search') {
    const keywords = body.message.replace(/[^\w\s]/g, '').slice(0, 100);
    const jobs = await c.env.DB.prepare(
      `SELECT j.title, ep.company_name, j.location, j.employment_type, j.salary_min, j.salary_max
       FROM jobs j
       JOIN employer_profiles ep ON ep.user_id = j.employer_id
       WHERE j.status = 'active'
         AND (j.title LIKE ? OR j.description LIKE ?)
         AND (j.expires_at IS NULL OR j.expires_at > datetime('now'))
       LIMIT 5`
    )
      .bind(`%${keywords}%`, `%${keywords}%`)
      .all<{ title: string; company_name: string; location: string; employment_type: string; salary_min: number | null; salary_max: number | null }>();

    if (jobs.results?.length) {
      context =
        'Relevant jobs found:\n' +
        jobs.results
          .map(
            (j) =>
              `- ${j.title} at ${j.company_name} (${j.location}, ${j.employment_type}` +
              (j.salary_min ? `, HKD ${j.salary_min}–${j.salary_max ?? '?'}/month` : '') +
              ')'
          )
          .join('\n');
    }
  }

  // Build full history for the request
  const fullHistory = [
    ...history,
    { role: 'user' as const, content: body.message },
  ];

  const { reply, tokensUsed } = await chatReply(client, fullHistory, context);

  // Persist user message + reply
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO chatbot_messages (session_id, role, content, intent) VALUES (?, ?, ?, ?)'
    ).bind(sessionId, 'user', body.message, intent),
    c.env.DB.prepare(
      'INSERT INTO chatbot_messages (session_id, role, content, tokens_used) VALUES (?, ?, ?, ?)'
    ).bind(sessionId, 'assistant', reply, tokensUsed),
    c.env.DB.prepare(
      "UPDATE chatbot_sessions SET last_active = datetime('now') WHERE id = ?"
    ).bind(sessionId),
  ]);

  return c.json({ reply, intent, session_id: sessionId });
});

// GET /chatbot/sessions/:id — get message history
ai.get('/chatbot/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');

  const session = await c.env.DB.prepare('SELECT * FROM chatbot_sessions WHERE id = ?')
    .bind(sessionId)
    .first();

  if (!session) return c.json({ error: 'Not Found', message: 'Session not found' }, 404);

  const messages = await c.env.DB.prepare(
    `SELECT role, content, intent, created_at
     FROM chatbot_messages WHERE session_id = ? ORDER BY created_at ASC`
  )
    .bind(sessionId)
    .all<{ role: string; content: string; intent: string | null; created_at: string }>();

  return c.json({ session_id: sessionId, messages: messages.results ?? [] });
});

export default ai;
