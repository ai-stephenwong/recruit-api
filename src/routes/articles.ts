import { Hono } from 'hono';
import type { Env, Variables, ArticleRow, CreateArticleBody } from '../types';
import { authMiddleware, requireRole } from '../middleware/auth';

const articles = new Hono<{ Bindings: Env; Variables: Variables }>();

function parsePagination(page: string | undefined, limit: string | undefined) {
  const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ─── GET /api/articles ────────────────────────────────────────────────────────

articles.get('/', async (c) => {
  const { page, limit, offset } = parsePagination(c.req.query('page'), c.req.query('limit'));

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM content_articles WHERE status = 'published'"
  ).first<{ total: number }>();

  const total = countRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT ca.id, ca.title, ca.slug, ca.published_at, ca.created_at, u.email as author_email
     FROM content_articles ca
     JOIN users u ON u.id = ca.author_id
     WHERE ca.status = 'published'
     ORDER BY ca.published_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<Pick<ArticleRow, 'id' | 'title' | 'slug' | 'published_at' | 'created_at'> & { author_email: string }>();

  return c.json({
    data: rows.results ?? [],
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

// ─── GET /api/articles/:slug ──────────────────────────────────────────────────

articles.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const article = await c.env.DB.prepare(
    `SELECT ca.*, u.email as author_email
     FROM content_articles ca
     JOIN users u ON u.id = ca.author_id
     WHERE ca.slug = ? AND ca.status = 'published'`
  )
    .bind(slug)
    .first<ArticleRow & { author_email: string }>();

  if (!article) {
    return c.json({ error: 'Not Found', message: 'Article not found' }, 404);
  }

  return c.json({ data: article });
});

// ─── POST /api/articles (admin only) ─────────────────────────────────────────

articles.post('/', authMiddleware, requireRole('admin'), async (c) => {
  let body: CreateArticleBody;

  try {
    body = await c.req.json<CreateArticleBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { title, body: articleBody, status = 'draft' } = body;
  let { slug } = body;

  if (!title || !articleBody) {
    return c.json({ error: 'Bad Request', message: 'title and body are required' }, 400);
  }

  if (!slug) {
    slug = slugify(title);
  }

  if (!['draft', 'published'].includes(status)) {
    return c.json({ error: 'Bad Request', message: "status must be 'draft' or 'published'" }, 400);
  }

  // Ensure slug is unique
  const existingSlug = await c.env.DB.prepare('SELECT id FROM content_articles WHERE slug = ?')
    .bind(slug)
    .first<{ id: number }>();

  if (existingSlug) {
    slug = `${slug}-${Date.now()}`;
  }

  const authorId = c.get('userId');
  const publishedAt = status === 'published' ? new Date().toISOString() : null;

  const result = await c.env.DB.prepare(
    `INSERT INTO content_articles (title, slug, body, author_id, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(title, slug, articleBody, authorId, status, publishedAt)
    .first<ArticleRow>();

  if (!result) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to create article' }, 500);
  }

  return c.json({ message: 'Article created successfully', data: result }, 201);
});

// ─── PUT /api/articles/:id (admin only) ──────────────────────────────────────

articles.put('/:id', authMiddleware, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid article ID' }, 400);
  }

  let body: Partial<CreateArticleBody>;
  try {
    body = await c.req.json<Partial<CreateArticleBody>>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT * FROM content_articles WHERE id = ?')
    .bind(id)
    .first<ArticleRow>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Article not found' }, 404);
  }

  const newStatus = body.status ?? existing.status;

  // Set published_at when transitioning to published
  let publishedAt = existing.published_at;
  if (newStatus === 'published' && existing.status !== 'published') {
    publishedAt = new Date().toISOString();
  }

  const updated = await c.env.DB.prepare(
    `UPDATE content_articles
     SET title = ?, slug = ?, body = ?, status = ?, published_at = ?
     WHERE id = ?
     RETURNING *`
  )
    .bind(
      body.title ?? existing.title,
      body.slug ?? existing.slug,
      body.body ?? existing.body,
      newStatus,
      publishedAt,
      id
    )
    .first<ArticleRow>();

  if (!updated) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to update article' }, 500);
  }

  return c.json({ message: 'Article updated successfully', data: updated });
});

// ─── DELETE /api/articles/:id (admin only) ────────────────────────────────────

articles.delete('/:id', authMiddleware, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Bad Request', message: 'Invalid article ID' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM content_articles WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();

  if (!existing) {
    return c.json({ error: 'Not Found', message: 'Article not found' }, 404);
  }

  await c.env.DB.prepare('DELETE FROM content_articles WHERE id = ?').bind(id).run();

  return c.json({ message: 'Article deleted successfully' });
});

export default articles;
