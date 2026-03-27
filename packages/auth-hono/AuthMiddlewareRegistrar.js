/**
 * AuthMiddlewareRegistrar.js — Registers JWT auth middleware on protected paths.
 *
 * Uses boot-hono's imperative routes() hook (called by HonoControllerRegistrar
 * for components without __routes). This ensures app.use() is registered BEFORE
 * route handlers — Hono middleware order is significant.
 *
 * Register this component BEFORE AuthController in the CDI context array to
 * guarantee the middleware is applied first.
 *
 * Protected paths:
 *   /auth/me            — GET current user identity
 *   /:application/sync  — POST sync endpoint (M003)
 *
 * CDI autowires:
 *   this.jwtSecret — JWT secret string
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
    if (!this.jwtSecret) return;
    const mw = authMiddleware(this.jwtSecret, this.logger);
    app.use('/auth/me',          mw);
    app.use('/auth/link/*',      mw);
    app.use('/auth/providers/*', mw);
    app.use('/:application/sync', mw);
    this.logger?.debug?.('[AuthMiddlewareRegistrar] JWT middleware applied to /auth/me, /auth/link/*, /auth/providers/*, /:application/sync');
  }
}
