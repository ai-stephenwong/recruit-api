import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { corsMiddleware } from './middleware/cors';

// Route modules
import authRoutes from './routes/auth';
import jobRoutes from './routes/jobs';
import applicationRoutes from './routes/applications';
import candidateRoutes from './routes/candidates';
import employerRoutes from './routes/employers';
import adminRoutes from './routes/admin';
import articleRoutes from './routes/articles';
import saved from './routes/saved';
import alerts from './routes/alerts';

// ─── App factory ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Global middleware ────────────────────────────────────────────────────────

app.use('*', corsMiddleware);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    name: 'Recruit.com.hk API',
    version: '1.0.0',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.route('/api/auth', authRoutes);
app.route('/api/jobs', jobRoutes);
app.route('/api/applications', applicationRoutes);
app.route('/api/candidates', candidateRoutes);
app.route('/api/employers', employerRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/articles', articleRoutes);
app.route('/api/saved', saved);
app.route('/api/alerts', alerts);

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      message: `Route ${c.req.method} ${c.req.path} does not exist`,
    },
    404
  );
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error(`[Error] ${c.req.method} ${c.req.path}:`, err);

  // Hono throws HTTPException instances for things like method-not-allowed
  if ('status' in err && typeof (err as { status: unknown }).status === 'number') {
    const httpErr = err as { status: number; message: string };
    return c.json({ error: 'HTTP Error', message: httpErr.message }, httpErr.status as 400);
  }

  return c.json(
    {
      error: 'Internal Server Error',
      message: 'An unexpected error occurred. Please try again later.',
    },
    500
  );
});

// ─── Export default fetch handler ─────────────────────────────────────────────

export default app;
