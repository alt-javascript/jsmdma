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
 *   this.authService            — AuthService instance
 *   this.userRepository         — UserRepository instance (profile projection sync)
 *   this.oauthIdentityLinkStore — provider-anchor ownership authority
 *   this.providers              — { [providerName]: providerInstance } map
 *   this.logger                 — optional logger
 */
const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
  503: 'service_unavailable',
});

const REQUEST_VALIDATION_REASONS = new Set([
  'non_empty_string_required',
  'invalid_operation_shape',
  'unsupported_provider',
  'unknown_state',
  'state_mismatch',
  'malformed_provider_callback',
]);

const STATUS_BY_OAUTH_CODE = Object.freeze({
  identity_link_conflict: 409,
  last_provider_unlink_forbidden: 409,
  identity_link_not_found: 404,
  invalid_state: 500,
  internal_error: 500,
});

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function errorCodeForStatus(statusCode) {
  if (ERROR_CODE_BY_STATUS[statusCode]) {
    return ERROR_CODE_BY_STATUS[statusCode];
  }
  if (statusCode >= 500) return 'internal_error';
  if (statusCode >= 400) return 'request_error';
  return 'unknown_error';
}

function failure(statusCode, error, extras = {}) {
  const base = {
    error,
    code: errorCodeForStatus(statusCode),
  };

  if (statusCode >= 500) {
    return {
      statusCode,
      body: {
        ...base,
        ...(extras.code ? { code: extras.code } : {}),
      },
    };
  }

  return {
    statusCode,
    body: {
      ...base,
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

function oauthCodeFromError(err) {
  const value = firstDefined(err?.code, err?.errorCode);
  return hasNonEmptyString(value) ? value.trim() : null;
}

function oauthReasonFromError(err) {
  const value = firstDefined(err?.reason, err?.diagnostics?.reason);
  return hasNonEmptyString(value) ? value.trim() : null;
}

function oauthDetailsFromError(err) {
  return firstDefined(err?.details, err?.diagnostics);
}

function createTypedOauthError({
  message,
  code = 'invalid_state',
  reason = 'malformed_dependency_response',
  status = 500,
  details,
  cause,
}) {
  const err = new Error(message);
  err.name = 'OAuthIdentityError';
  err.code = code;
  err.reason = reason;
  err.status = status;
  err.diagnostics = details ?? { reason };

  if (details !== undefined) {
    err.details = details;
  }

  if (cause !== undefined) {
    err.cause = cause;
  }

  return err;
}

function normalizeProjectionLinks(links, operation) {
  if (!Array.isArray(links)) {
    throw createTypedOauthError({
      message: `OAuth identity store ${operation} returned malformed links payload.`,
      details: { operation },
    });
  }

  const normalized = links.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw createTypedOauthError({
        message: `OAuth identity store ${operation} returned malformed link entry at index ${index}.`,
        details: { operation, index },
      });
    }

    const provider = hasNonEmptyString(entry.provider) ? entry.provider.trim() : null;
    const providerUserId = hasNonEmptyString(entry.providerUserId) ? entry.providerUserId.trim() : null;

    if (!provider || !providerUserId) {
      throw createTypedOauthError({
        message: `OAuth identity store ${operation} returned incomplete link entry at index ${index}.`,
        details: { operation, index },
      });
    }

    return { provider, providerUserId };
  });

  const seenProviders = new Set();
  for (const entry of normalized) {
    if (seenProviders.has(entry.provider)) {
      throw createTypedOauthError({
        message: 'OAuth identity store returned duplicate provider entries for a user.',
        reason: 'invalid_projection_state',
        details: { operation },
      });
    }
    seenProviders.add(entry.provider);
  }

  return normalized;
}

function inferStatusForOauthError(err, code, reason) {
  if (Number.isInteger(err?.status)) return err.status;
  if (Number.isInteger(err?.statusCode)) return err.statusCode;

  if (reason === 'dependency_timeout') return 503;
  if (REQUEST_VALIDATION_REASONS.has(reason)) return 400;

  if (code && STATUS_BY_OAUTH_CODE[code]) {
    return STATUS_BY_OAUTH_CODE[code];
  }

  return 500;
}

function errorMessageForOauthFailure({ status, code, fallbackMessage }) {
  if (status >= 500) return fallbackMessage;

  if (code === 'identity_link_conflict') {
    return 'This provider account is already linked to another user';
  }

  if (code === 'last_provider_unlink_forbidden') {
    return 'Cannot remove last provider — you would be locked out';
  }

  if (code === 'identity_link_not_found') {
    return 'Provider is not linked to this user';
  }

  return fallbackMessage;
}

function oauthFailure(err, { fallbackMessage }) {
  const code = oauthCodeFromError(err);
  const reason = oauthReasonFromError(err);

  const rawDetails = oauthDetailsFromError(err);
  if (rawDetails !== undefined && !isPlainObject(rawDetails)) {
    return failure(500, fallbackMessage, {
      code: 'invalid_state',
    });
  }

  const status = inferStatusForOauthError(err, code, reason);
  const extras = {};

  if (hasNonEmptyString(code)) {
    extras.code = code;
  }

  if (status < 500 && reason !== null) {
    extras.reason = reason;
  }

  if (status < 500 && rawDetails !== undefined) {
    extras.details = rawDetails;
  }

  const error = errorMessageForOauthFailure({ status, code, fallbackMessage });

  return failure(status, error, extras);
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
    this.authService = null; // CDI autowired
    this.userRepository = null; // CDI autowired
    this.oauthIdentityLinkStore = null; // CDI autowired
    this.providers = {}; // set directly or by authHonoStarter()
    this.logger = null; // CDI autowired
    this.spaOrigin = null; // set at runtime (e.g. 'http://localhost:8080')
  }

  // ── auth helpers ───────────────────────────────────────────────────────────

  _getUser(request) {
    return request.honoCtx?.get('user') ?? null;
  }

  _requireIdentityStore() {
    const store = this.oauthIdentityLinkStore;
    if (
      !store
      || typeof store.link !== 'function'
      || typeof store.unlink !== 'function'
      || typeof store.getLinksForUser !== 'function'
    ) {
      this.logger?.error?.('[AuthController] oauthIdentityLinkStore dependency is not configured correctly.');
      return null;
    }
    return store;
  }

  async _readLinksFromStore(store, userId, operation) {
    let links;

    try {
      links = await store.getLinksForUser(userId);
    } catch (err) {
      if (hasNonEmptyString(oauthCodeFromError(err))) {
        throw err;
      }

      const message = hasNonEmptyString(err?.message) ? err.message : String(err ?? 'Unknown error');
      const timeoutLike = /timeout/i.test(message) || err?.code === 'ETIMEDOUT';
      throw createTypedOauthError({
        message: `OAuth identity store ${operation} failed: ${message}`,
        reason: timeoutLike ? 'dependency_timeout' : 'malformed_dependency_response',
        details: { operation },
        status: timeoutLike ? 503 : 500,
        cause: err,
      });
    }

    return normalizeProjectionLinks(links, operation);
  }

  async _syncProvidersProjection(userId, links) {
    try {
      return await this.userRepository.syncProvidersProjection(userId, links);
    } catch (err) {
      this.logger?.error?.(`[AuthController] syncProvidersProjection failed userId=${userId}: ${err?.message ?? err}`);
      return null;
    }
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
      userId: user.sub,
      email: user.email ?? null,
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

    const store = this._requireIdentityStore();
    if (!store) return failure(500, 'Provider link failed');

    const { code, state, stored_state: storedState, code_verifier: codeVerifier } = request.query;
    if (!code || !state || !storedState) {
      return failure(400, 'Missing required query params: code, state, stored_state');
    }

    if (state !== storedState) {
      return failure(400, 'OAuth state mismatch', {
        code: 'invalid_state',
        reason: 'state_mismatch',
      });
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
      return failure(400, 'Provider callback failed', {
        code: 'invalid_state',
        reason: 'malformed_provider_callback',
      });
    }

    const providerUserId = callbackResult.providerUserId.trim();

    try {
      await store.link({
        userId: user.sub,
        provider,
        providerUserId,
      });
    } catch (err) {
      this.logger?.warn?.(`[AuthController] linkProvider store.link failed userId=${user.sub} provider=${provider}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider link failed' });
    }

    let links;
    try {
      links = await this._readLinksFromStore(store, user.sub, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] linkProvider getLinksForUser failed userId=${user.sub}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider link failed' });
    }

    const updatedUser = await this._syncProvidersProjection(user.sub, links);
    if (!updatedUser) {
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
    const instance = this.providers[provider];
    if (!instance) return failure(400, `Unknown provider: ${provider}`);

    const store = this._requireIdentityStore();
    if (!store) return failure(500, 'Provider unlink failed');

    let existingLinks;
    try {
      existingLinks = await this._readLinksFromStore(store, user.sub, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlinkProvider getLinksForUser failed userId=${user.sub}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider unlink failed' });
    }

    const current = existingLinks.find((entry) => entry.provider === provider);
    if (!current) {
      return failure(404, 'Provider is not linked to this user', {
        code: 'identity_link_not_found',
        reason: 'provider_not_linked',
      });
    }

    if (existingLinks.length <= 1) {
      return failure(409, 'Cannot remove last provider — you would be locked out', {
        code: 'last_provider_unlink_forbidden',
        reason: 'last_linked_provider',
      });
    }

    try {
      await store.unlink({
        userId: user.sub,
        provider,
        providerUserId: current.providerUserId,
      });
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlinkProvider store.unlink failed userId=${user.sub} provider=${provider}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider unlink failed' });
    }

    let links;
    try {
      links = await this._readLinksFromStore(store, user.sub, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlinkProvider post-unlink getLinksForUser failed userId=${user.sub}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider unlink failed' });
    }

    const updatedUser = await this._syncProvidersProjection(user.sub, links);
    if (!updatedUser) {
      return failure(500, 'Provider unlink failed');
    }

    this.logger?.info?.(`[AuthController] unlinkProvider userId=${user.sub} provider=${provider}`);
    return { providers: updatedUser.providers };
  }

  /**
   * GET /auth/:provider
   * Initiates OAuth flow. Returns { authorizationURL, state }.
   * PKCE verifier remains server-side in AuthService and is not exposed here.
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
      if (err?.name === 'InvalidStateError') {
        return failure(400, err.message, {
          code: 'invalid_state',
          reason: 'unknown_state',
        });
      }

      if (hasNonEmptyString(oauthCodeFromError(err))) {
        this.logger?.warn?.(`[AuthController] completeAuth typed failure provider=${provider} code=${oauthCodeFromError(err)} reason=${oauthReasonFromError(err) ?? 'n/a'}`);
        return oauthFailure(err, { fallbackMessage: 'Authentication failed' });
      }

      this.logger?.error?.(`[AuthController] completeAuth error: ${err?.message ?? err}`);
      return failure(500, 'Authentication failed');
    }
  }
}
