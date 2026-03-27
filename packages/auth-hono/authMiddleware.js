/**
 * authMiddleware.js — Hono JWT auth middleware factory
 *
 * Usage:
 *   import { authMiddleware } from '@alt-javascript/data-api-auth-hono';
 *   app.use('/protected/*', authMiddleware(jwtSecret));
 *
 * On success: attaches the verified JWT payload to c.set('user', payload).
 * On near-expiry (needsRefresh): also sets X-Auth-Token response header with a
 * refreshed token so the client can silently extend its session.
 *
 * On failure: returns 401 JSON with a typed error body.
 */
import { JwtSession, InvalidTokenError, IdleExpiredError, HardExpiredError } from '@alt-javascript/data-api-auth-core';

/**
 * Create a JWT auth middleware for Hono.
 *
 * @param {string | Uint8Array} jwtSecret
 * @param {object} [logger]
 * @returns {Function} Hono middleware: (c, next) => Promise<void>
 */
export function authMiddleware(jwtSecret, logger) {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger?.debug?.('[authMiddleware] missing Authorization header');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.slice(7); // strip 'Bearer '

    let payload;
    try {
      payload = await JwtSession.verify(token, jwtSecret);
    } catch (err) {
      if (err instanceof IdleExpiredError) {
        logger?.info?.('[authMiddleware] idle TTL exceeded');
        return c.json({ error: 'Session expired', reason: 'idle' }, 401);
      }
      if (err instanceof HardExpiredError) {
        logger?.info?.('[authMiddleware] hard TTL exceeded');
        return c.json({ error: 'Session expired', reason: 'hard' }, 401);
      }
      // InvalidTokenError or any other error
      logger?.debug?.('[authMiddleware] invalid token:', err.message);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Attach user to context
    c.set('user', payload);

    // Rolling refresh: if token is old enough, issue a fresh one
    if (JwtSession.needsRefresh(payload)) {
      try {
        const freshToken = await JwtSession.refresh(payload, jwtSecret);
        c.header('X-Auth-Token', freshToken);
        logger?.debug?.('[authMiddleware] issued rolling refresh token');
      } catch {
        // Non-fatal — proceed without refresh
      }
    }

    await next();
  };
}

/**
 * Read the authenticated user from Hono context.
 * Returns null if not authenticated (middleware may be optional on some routes).
 *
 * @param {import('hono').Context} c
 * @returns {Object|null}
 */
export function getUser(c) {
  return c.get('user') ?? null;
}
