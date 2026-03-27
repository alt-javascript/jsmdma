/**
 * AuthController.js — Hono controller for OAuth auth routes.
 *
 * Routes:
 *   GET    /auth/me                    — return current user from JWT (requires auth)
 *   POST   /auth/logout                — stateless logout guidance
 *   POST   /auth/link/:provider        — link additional provider to existing identity (requires auth)
 *   DELETE /auth/providers/:provider   — unlink a provider (requires auth; 409 if last)
 *   GET    /auth/:provider             — initiate OAuth flow
 *   GET    /auth/:provider/callback    — complete OAuth flow
 *
 * IMPORTANT: static routes (/auth/me, /auth/logout, /auth/link/*, /auth/providers/*)
 * MUST come before parameterized routes (/auth/:provider) in __routes to prevent
 * the wildcard from matching static paths first in Hono.
 *
 * JWT auth middleware is applied by AuthMiddlewareRegistrar (registered before
 * this controller in the CDI context). Protected routes read the user via
 * request.honoCtx.get('user').
 *
 * CDI autowires:
 *   this.authService     — AuthService instance
 *   this.userRepository  — UserRepository instance (for link/unlink)
 *   this.providers       — { [providerName]: providerInstance } map
 *   this.logger          — optional logger
 */
export default class AuthController {
  static __routes = [
    // Static routes first — prevents /auth/:provider from matching these
    { method: 'GET',    path: '/auth/me',                  handler: 'me'             },
    { method: 'POST',   path: '/auth/logout',              handler: 'logout'         },
    { method: 'POST',   path: '/auth/link/:provider',      handler: 'linkProvider'   },
    { method: 'DELETE', path: '/auth/providers/:provider', handler: 'unlinkProvider' },
    // Parameterized routes after static ones
    { method: 'GET',    path: '/auth/:provider',           handler: 'beginAuth'      },
    { method: 'GET',    path: '/auth/:provider/callback',  handler: 'completeAuth'   },
  ];

  constructor() {
    this.authService    = null; // CDI autowired
    this.userRepository = null; // CDI autowired
    this.providers      = {};   // set directly or by authHonoStarter()
    this.logger         = null; // CDI autowired
  }

  // ── auth helpers ───────────────────────────────────────────────────────────

  _getUser(request) {
    return request.honoCtx?.get('user') ?? null;
  }

  // ── route handlers ─────────────────────────────────────────────────────────

  /**
   * GET /auth/me
   * Returns the current user's identity from the JWT payload.
   */
  me(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Unauthorized' } };
    return {
      userId:    user.sub,
      email:     user.email ?? null,
      providers: user.providers ?? [],
    };
  }

  /**
   * POST /auth/logout — stateless logout guidance.
   */
  logout() {
    return {
      message: 'Delete your stored token to log out. JWTs are stateless — there is no server-side session to invalidate.',
    };
  }

  /**
   * POST /auth/link/:provider
   * Links an additional OAuth provider to the authenticated user's identity.
   * Requires a valid JWT. Validates the OAuth callback in the same request.
   */
  async linkProvider(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Unauthorized' } };

    const { provider } = request.params;
    const instance     = this.providers[provider];
    if (!instance) return { statusCode: 400, body: { error: `Unknown provider: ${provider}` } };

    const { code, state, stored_state: storedState, code_verifier: codeVerifier } = request.query;
    if (!code || !state || !storedState) {
      return { statusCode: 400, body: { error: 'Missing required query params: code, state, stored_state' } };
    }

    if (state !== storedState) {
      return { statusCode: 400, body: { error: 'OAuth state mismatch' } };
    }

    let callbackResult;
    try {
      callbackResult = await instance.validateCallback(code, codeVerifier ?? '');
    } catch (err) {
      return { statusCode: 500, body: { error: `Provider error: ${err.message}` } };
    }

    const { providerUserId } = callbackResult;

    // Check if this providerUserId is already linked to any user
    const existingUser = await this.userRepository.findByProvider(provider, providerUserId);
    if (existingUser) {
      return { statusCode: 409, body: { error: 'This provider account is already linked to another user' } };
    }

    const updatedUser = await this.userRepository.addProvider(user.sub, provider, providerUserId);
    this.logger?.info?.(`[AuthController] linkProvider userId=${user.sub} provider=${provider}`);
    return { user: updatedUser };
  }

  /**
   * DELETE /auth/providers/:provider
   * Removes an OAuth provider from the authenticated user's identity.
   * Returns 409 if this is the user's only provider.
   */
  async unlinkProvider(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Unauthorized' } };

    const { provider } = request.params;

    const fullUser = await this.userRepository.getUser(user.sub);
    if (!fullUser) return { statusCode: 404, body: { error: 'User not found' } };

    if (fullUser.providers.length <= 1) {
      return { statusCode: 409, body: { error: 'Cannot remove last provider — you would be locked out' } };
    }

    const updatedUser = await this.userRepository.removeProvider(user.sub, provider);
    this.logger?.info?.(`[AuthController] unlinkProvider userId=${user.sub} provider=${provider}`);
    return { providers: updatedUser.providers };
  }

  /**
   * GET /auth/:provider
   * Initiates OAuth flow. Returns { authorizationURL, state, codeVerifier }.
   */
  beginAuth(request) {
    const { provider } = request.params;
    const instance     = this.providers[provider];
    if (!instance) return { statusCode: 400, body: { error: `Unknown provider: ${provider}` } };

    const result = this.authService.beginAuth(provider, instance);
    this.logger?.debug?.(`[AuthController] beginAuth provider=${provider}`);
    return result;
  }

  /**
   * GET /auth/:provider/callback
   * Completes OAuth flow. Returns { user, token }.
   */
  async completeAuth(request) {
    const { provider }  = request.params;
    const instance      = this.providers[provider];
    if (!instance) return { statusCode: 400, body: { error: `Unknown provider: ${provider}` } };

    const { code, state, stored_state: storedState, code_verifier: codeVerifier } = request.query;
    if (!code || !state || !storedState) {
      return { statusCode: 400, body: { error: 'Missing required query params: code, state, stored_state' } };
    }

    try {
      const result = await this.authService.completeAuth(
        provider, instance, code, state, storedState, codeVerifier ?? '',
      );
      this.logger?.info?.(`[AuthController] completeAuth provider=${provider} userId=${result.user.userId}`);
      return result;
    } catch (err) {
      if (err.name === 'InvalidStateError') return { statusCode: 400, body: { error: err.message } };
      this.logger?.error?.(`[AuthController] completeAuth error: ${err.message}`);
      return { statusCode: 500, body: { error: 'Authentication failed' } };
    }
  }
}
