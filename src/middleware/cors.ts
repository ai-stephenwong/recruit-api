import { Context, Next } from 'hono';
import type { Env, Variables } from '../types';

const ALLOWED_ORIGINS: (string | RegExp)[] = [
  'http://localhost:3000',
  'http://localhost:3001',
  /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/,
];

function isAllowedOrigin(origin: string): boolean {
  for (const allowed of ALLOWED_ORIGINS) {
    if (typeof allowed === 'string') {
      if (origin === allowed) return true;
    } else {
      if (allowed.test(origin)) return true;
    }
  }
  return false;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * CORS middleware that permits requests from localhost dev servers and any
 * Vercel preview / production deployment (*.vercel.app).
 */
export async function corsMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
): Promise<Response | void> {
  const origin = c.req.header('Origin') ?? '';
  const allowed = isAllowedOrigin(origin);

  // Pre-flight
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowed ? origin : '',
        ...CORS_HEADERS,
      },
    });
  }

  await next();

  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      c.res.headers.set(key, value);
    }
  }
}
