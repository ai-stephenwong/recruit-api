import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { Env, Variables, UserRow, RegisterBody, LoginBody, AuthTokens } from '../types';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

async function generateToken(
  userId: number,
  email: string,
  role: string,
  secret: string
): Promise<AuthTokens> {
  const secretKey = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ sub: String(userId), email, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRES_IN_SECONDS)
    .sign(secretKey);

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: JWT_EXPIRES_IN_SECONDS,
  };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

auth.post('/register', async (c) => {
  let body: RegisterBody;

  try {
    body = await c.req.json<RegisterBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { email, password, role } = body;

  if (!email || !password || !role) {
    return c.json({ error: 'Bad Request', message: 'email, password, and role are required' }, 400);
  }

  if (!isValidEmail(email)) {
    return c.json({ error: 'Bad Request', message: 'Invalid email address' }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: 'Bad Request', message: 'Password must be at least 8 characters' }, 400);
  }

  if (!['candidate', 'employer'].includes(role)) {
    return c.json({ error: 'Bad Request', message: "role must be 'candidate' or 'employer'" }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: number }>();

  if (existing) {
    return c.json({ error: 'Conflict', message: 'An account with this email already exists' }, 409);
  }

  const passwordHash = await hashPassword(password);

  const result = await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?) RETURNING id, email, role, created_at'
  )
    .bind(email.toLowerCase(), passwordHash, role)
    .first<Pick<UserRow, 'id' | 'email' | 'role' | 'created_at'>>();

  if (!result) {
    return c.json({ error: 'Internal Server Error', message: 'Failed to create user' }, 500);
  }

  // Create an empty profile for the new user
  if (role === 'candidate') {
    await c.env.DB.prepare(
      'INSERT INTO candidate_profiles (user_id, full_name) VALUES (?, ?)'
    )
      .bind(result.id, email.split('@')[0])
      .run();
  } else if (role === 'employer') {
    await c.env.DB.prepare(
      'INSERT INTO employer_profiles (user_id, company_name) VALUES (?, ?)'
    )
      .bind(result.id, 'My Company')
      .run();
  }

  const tokens = await generateToken(result.id, result.email, result.role, c.env.JWT_SECRET);

  return c.json(
    {
      message: 'Registration successful',
      user: { id: result.id, email: result.email, role: result.role, created_at: result.created_at },
      ...tokens,
    },
    201
  );
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

auth.post('/login', async (c) => {
  let body: LoginBody;

  try {
    body = await c.req.json<LoginBody>();
  } catch {
    return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
  }

  const { email, password } = body;

  if (!email || !password) {
    return c.json({ error: 'Bad Request', message: 'email and password are required' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<UserRow>();

  if (!user) {
    return c.json({ error: 'Unauthorized', message: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Unauthorized', message: 'Invalid email or password' }, 401);
  }

  const tokens = await generateToken(user.id, user.email, user.role, c.env.JWT_SECRET);

  return c.json({
    message: 'Login successful',
    user: { id: user.id, email: user.email, role: user.role, created_at: user.created_at },
    ...tokens,
  });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const user = await c.env.DB.prepare(
    'SELECT id, email, role, created_at FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'email' | 'role' | 'created_at'>>();

  if (!user) {
    return c.json({ error: 'Not Found', message: 'User not found' }, 404);
  }

  return c.json({ user });
});

export default auth;
