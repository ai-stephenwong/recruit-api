import { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import type { Env, Variables, JWTPayload, UserRole } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Verifies the Bearer JWT token from the Authorization header.
 * On success, sets userId, userEmail, and userRole in context variables.
 */
export async function authMiddleware(c: AppContext, next: Next): Promise<Response | void> {
  const authorization = c.req.header('Authorization');

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authorization.slice(7);

  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Internal Server Error', message: 'JWT secret not configured' }, 500);
  }

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    const jwtPayload = payload as unknown as JWTPayload;

    if (!jwtPayload.sub || !jwtPayload.email || !jwtPayload.role) {
      return c.json({ error: 'Unauthorized', message: 'Invalid token payload' }, 401);
    }

    c.set('userId', parseInt(jwtPayload.sub, 10));
    c.set('userEmail', jwtPayload.email);
    c.set('userRole', jwtPayload.role);

    await next();
  } catch {
    return c.json({ error: 'Unauthorized', message: 'Invalid or expired token' }, 401);
  }
}

/**
 * Factory that returns middleware requiring one of the specified roles.
 * Must be used after authMiddleware.
 */
export function requireRole(...roles: UserRole[]) {
  return async (c: AppContext, next: Next): Promise<Response | void> => {
    const userRole = c.get('userRole');

    if (!roles.includes(userRole)) {
      return c.json(
        {
          error: 'Forbidden',
          message: `This endpoint requires one of the following roles: ${roles.join(', ')}`,
        },
        403
      );
    }

    await next();
  };
}
