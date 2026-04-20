/**
 * AuthMiddlewareRegistrar.js — Registers JWT auth middleware on protected paths.
 *
 * Uses boot-hono's imperative routes() hook (called by HonoControllerRegistrar
 * for components without __routes). This ensures app.use() is registered BEFORE
 * route handlers — Hono middleware order is significant.
 *
 * Register this component BEFORE AuthController in the CDI context array to
 * guarantee middleware ordering on protected non-lifecycle routes.
 *
 * IMPORTANT:
 * - Lifecycle auth routes (/auth/login/finalize, /auth/me, /auth/link/finalize,
 *   /auth/unlink/:provider, /auth/signout) are mode-aware and resolve credentials
 *   in AuthController (cookie or bearer).
 * - This registrar continues to bearer-protect non-lifecycle application/org
 *   surfaces.
 *
 * Protected paths:
 *   /:application/sync   — POST sync endpoint
 *   /:application/search — POST search endpoint
 *   /orgs               — POST create org, GET list orgs
 *   /orgs/*             — all org member management routes
 *   /docIndex/*         — all DocIndexController routes
 *   /account/*          — all account export routes
 *
 * CDI autowires:
 *   this.jwtSecret — JWT secret string (required, >= 32 chars; fail-fast on invalid)
 *   this.logger    — optional logger
 */
import { authMiddleware } from './authMiddleware.js';

export default class AuthMiddlewareRegistrar {
  // No __routes — this component only uses the imperative routes() hook

  constructor() {
    this.jwtSecret = null; // CDI autowired
    this.logger    = null; // CDI autowired
  }

  /**
   * Register path-scoped JWT middleware.
   * @param {import('hono').Hono} app
   */
  routes(app) {
    if (typeof this.jwtSecret !== 'string' || this.jwtSecret.length < 32) {
      throw new Error('[AuthMiddlewareRegistrar] Missing or invalid config at auth.jwt.secret (expected string length >= 32)');
    }

    const mw = authMiddleware(this.jwtSecret, this.logger);
    app.use('/:application/sync',   mw);
    app.use('/:application/search', mw);
    app.use('/orgs',                mw);
    app.use('/orgs/*',              mw);
    app.use('/docIndex/*',          mw);
    app.use('/account/*',           mw);
    this.logger?.debug?.('[AuthMiddlewareRegistrar] JWT middleware applied to /:application/sync, /:application/search, /orgs, /orgs/*, /docIndex/*, /account/*; lifecycle /auth/* handled by mode-aware AuthController');
  }
}
