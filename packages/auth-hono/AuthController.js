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
const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
});

function errorCodeForStatus(statusCode) {
  if (ERROR_CODE_BY_STATUS[statusCode]) {
    return ERROR_CODE_BY_STATUS[statusCode];
  }
  if (statusCode >= 500) return 'internal_error';
  if (statusCode >= 400) return 'request_error';
  return 'unknown_error';
}

function failure(statusCode, error, extras = {}) {
  return {
    statusCode,
    body: {
      error,
      code: errorCodeForStatus(statusCode),
      ...extras,
    },
  };
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
    this.spaOrigin      = null; // set at runtime (e.g. 'http://localhost:8080')
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
    if (!user) return failure(401, 'Unauthorized');
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
    if (!user) return failure(401, 'Unauthorized');

    const { provider } = request.params;
    const instance = this.providers[provider];
    if (!instance) return failure(400, `Unknown provider: ${provider}`);

    const { code, state, stored_state: storedState, code_verifier: codeVerifier } = request.query;
    if (!code || !state || !storedState) {
      return failure(400, 'Missing required query params: code, state, stored_state');
    }

    if (state !== storedState) {
      return failure(400, 'OAuth state mismatch');
    }

    let callbackResult;
    try {
      callbackResult = await instance.validateCallback(code, codeVerifier ?? '');
    } catch (err) {
      this.logger?.error?.(`[AuthController] linkProvider callback failed for provider=${provider}: ${err?.message ?? err}`);
      return failure(500, 'Provider callback failed');
    }

    if (!isPlainObject(callbackResult) || !hasNonEmptyString(callbackResult.providerUserId)) {
      this.logger?.error?.(`[AuthController] linkProvider callback returned malformed payload for provider=${provider}`);
      return failure(500, 'Provider callback failed');
    }

    const { providerUserId } = callbackResult;

    let existingUser;
    try {
      existingUser = await this.userRepository.findByProvider(provider, providerUserId);
    } catch (err) {
      this.logger?.error?.(`[AuthController] linkProvider findByProvider failed: ${err?.message ?? err}`);
      return failure(500, 'Provider link failed');
    }

    // Check if this providerUserId is already linked to any user
    if (existingUser) {
      return failure(409, 'This provider account is already linked to another user');
    }

    let updatedUser;
    try {
      updatedUser = await this.userRepository.addProvider(user.sub, provider, providerUserId);
    } catch (err) {
      this.logger?.error?.(`[AuthController] linkProvider addProvider failed: ${err?.message ?? err}`);
      return failure(500, 'Provider link failed');
    }

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
    if (!user) return failure(401, 'Unauthorized');

    const { provider } = request.params;

    const fullUser = await this.userRepository.getUser(user.sub);
    if (!fullUser) return failure(404, 'User not found');

    if (fullUser.providers.length <= 1) {
      return failure(409, 'Cannot remove last provider — you would be locked out');
    }

    const updatedUser = await this.userRepository.removeProvider(user.sub, provider);
    this.logger?.info?.(`[AuthController] unlinkProvider userId=${user.sub} provider=${provider}`);
    return { providers: updatedUser.providers };
  }

  /**
   * GET /auth/:provider
   * Initiates OAuth flow. Returns { authorizationURL, state }.
   */
  beginAuth(request) {
    const { provider } = request.params;
    const instance = this.providers[provider];
    if (!instance) return failure(400, `Unknown provider: ${provider}`);

    const options = {};
    if (request.query?.link === 'true') options.link = true;

    const result = this.authService.beginAuth(provider, instance, options);
    this.logger?.debug?.(`[AuthController] beginAuth provider=${provider} link=${!!options.link}`);
    return result;
  }

  /**
   * GET /auth/:provider/callback
   * Completes OAuth flow. Redirects browser to {spaOrigin}/?token=<jwt>.
   */
  async completeAuth(request) {
    const { provider } = request.params;
    const instance = this.providers[provider];
    if (!instance) return failure(400, `Unknown provider: ${provider}`);

    const { code, state } = request.query;
    if (!code || !state) {
      return failure(400, 'Missing required query params: code, state');
    }

    try {
      const result = await this.authService.completeAuth(provider, instance, code, state);

      // Link mode: redirect to SPA with code instead of token
      if (result?.linkMode) {
        if (!hasNonEmptyString(result.code) || !hasNonEmptyString(result.state) || !hasNonEmptyString(result.codeVerifier)) {
          this.logger?.error?.(`[AuthController] completeAuth returned malformed link-mode payload for provider=${provider}`);
          return failure(500, 'Authentication failed');
        }

        const redirectUrl = `${this.spaOrigin ?? ''}/?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}&code_verifier=${encodeURIComponent(result.codeVerifier)}`;
        this.logger?.info?.(`[AuthController] completeAuth linkMode provider=${provider} — forwarding code to SPA`);
        return { redirect: redirectUrl, statusCode: 302 };
      }

      if (!hasNonEmptyString(result?.token)) {
        this.logger?.error?.(`[AuthController] completeAuth returned payload without token for provider=${provider}`);
        return failure(500, 'Authentication failed');
      }

      const redirectUrl = `${this.spaOrigin ?? ''}/?token=${encodeURIComponent(result.token)}`;
      this.logger?.info?.(`[AuthController] completeAuth provider=${provider} userId=${result?.user?.userId ?? 'unknown'}`);
      return { redirect: redirectUrl, statusCode: 302 };
    } catch (err) {
      if (err?.name === 'InvalidStateError') return failure(400, err.message);
      this.logger?.error?.(`[AuthController] completeAuth error: ${err?.message ?? err}`);
      return failure(500, 'Authentication failed');
    }
  }
}
