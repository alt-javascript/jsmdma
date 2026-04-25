/**
 * SearchController.js — Hono controller for ACL-gated document search.
 *
 * Routes:
 *   POST /:application/search — search documents for the given application
 *
 * The :application path segment is validated against the ApplicationRegistry
 * allowlist.  Unknown applications return 404.
 *
 * Authentication is required.  OAuthSessionMiddleware must be registered
 * before this controller in the CDI context.  The identity is read from
 * request.identity (set by OAuthSessionMiddleware); requests without a
 * valid session token are rejected with 401.
 *
 * Request body:
 *   { collection: string, filter: object (pre-built AST with type field) }
 *
 * ACL enforcement is delegated entirely to SearchService — private docs from
 * other users are never returned.
 *
 * CDI autowiring (by name):
 *   this.searchService        — SearchService instance
 *   this.applicationRegistry  — ApplicationRegistry instance
 *   this.logger               — optional logger
 */
export default class SearchController {
  static __routes = [
    { method: 'POST', path: '/:application/search', handler: 'search' },
  ];

  constructor() {
    this.searchService       = null; // CDI autowired
    this.applicationRegistry = null; // CDI autowired
    this.logger              = null; // CDI autowired
  }

  /**
   * POST /:application/search
   * @param {{ body: Object, params: Object, identity: Object }} request
   */
  async search(request) {
    const { body, params } = request;

    // ── Auth guard ────────────────────────────────────────────────────────────
    const userPayload = request.identity ?? null;
    if (!userPayload || !userPayload.userId) {
      this.logger?.debug?.('[SearchController] 401 — missing or invalid user payload');
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = userPayload.userId;

    // ── Application allowlist ────────────────────────────────────────────────
    const application = params?.application;
    if (!this.applicationRegistry?.isAllowed(application)) {
      this.logger?.debug?.(`[SearchController] 404 — unknown application: ${application}`);
      return { statusCode: 404, body: { error: `Unknown application: ${application}` } };
    }

    // ── Body validation ───────────────────────────────────────────────────────
    if (!body || typeof body !== 'object') {
      this.logger?.debug?.('[SearchController] 400 — missing request body');
      return { statusCode: 400, body: { error: 'Request body is required' } };
    }

    const { collection, filter } = body;

    if (!collection || typeof collection !== 'string') {
      this.logger?.debug?.('[SearchController] 400 — missing collection');
      return { statusCode: 400, body: { error: 'Missing required field: collection' } };
    }

    if (!filter || typeof filter !== 'object' || !filter.type) {
      this.logger?.debug?.('[SearchController] 400 — missing or invalid filter');
      return { statusCode: 400, body: { error: 'Missing or invalid field: filter (must be an object with a type field)' } };
    }

    // ── Search ────────────────────────────────────────────────────────────────
    const results = await this.searchService.search(collection, filter, userId, application);

    return { statusCode: 200, body: { results } };
  }
}
