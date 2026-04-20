/**
 * AuthController.js — Hono controller for OAuth auth routes.
 *
 * Lifecycle routes are mode-aware and support bearer or cookie sessions:
 *   GET    /auth/me
 *   POST   /auth/signout
 *   GET    /auth/login/finalize
 *   POST   /auth/login/finalize
 *   GET    /auth/link/finalize
 *   POST   /auth/link/finalize
 *   POST   /auth/unlink/:provider
 *   DELETE /auth/unlink/:provider
 *
 * Provider authorize start remains available at:
 *   GET    /auth/:provider
 *
 * IMPORTANT: static routes MUST appear before /auth/:provider in __routes.
 */
import { JwtSession, IdleExpiredError, HardExpiredError, InvalidStateError } from '@alt-javascript/jsmdma-auth-core';
import {
  createSessionModeError,
  normalizeSessionModeLiteral,
  resolveSessionMode,
} from './sessionModeContract.js';

const AUTH_SESSION_COOKIE = 'auth_session';
const AUTH_SESSION_COOKIE_ALIASES = [AUTH_SESSION_COOKIE, 'auth_token', 'session_token'];

const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
  503: 'service_unavailable',
});

const STATUS_BY_OAUTH_CODE = Object.freeze({
  identity_link_conflict: 409,
  last_provider_unlink_forbidden: 409,
  identity_link_not_found: 404,
  invalid_state: 500,
  internal_error: 500,
});

const KNOWN_OAUTH_CODES = new Set(Object.keys(STATUS_BY_OAUTH_CODE));

const REASON_ALIASES = Object.freeze({
  last_linked_provider: 'last_provider_lockout',
});

const REQUEST_VALIDATION_REASONS = new Set([
  'non_empty_string_required',
  'invalid_operation_shape',
  'unsupported_provider',
  'unknown_state',
  'state_mismatch',
  'malformed_provider_callback',
]);

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSecretValue(value) {
  return (typeof value === 'string' && value.length > 0)
    || value instanceof Uint8Array;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
        ...(statusCode === 503 && extras.reason ? { reason: extras.reason } : {}),
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

function normalizeReasonLiteral(reason) {
  if (!hasNonEmptyString(reason)) return reason;
  return REASON_ALIASES[reason] ?? reason;
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
  const reason = normalizeReasonLiteral(oauthReasonFromError(err));

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

  if ((status < 500 || status === 503) && reason !== null) {
    extras.reason = reason;
  }

  if (status < 500 && code === 'last_provider_unlink_forbidden' && !extras.reason) {
    extras.reason = 'last_provider_lockout';
  }

  if ((status < 500 || status === 503) && rawDetails !== undefined) {
    extras.details = rawDetails;
  }

  const error = errorMessageForOauthFailure({ status, code, fallbackMessage });

  return failure(status, error, extras);
}

function parseCookieHeader(cookieHeader) {
  if (!hasNonEmptyString(cookieHeader)) return {};

  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const index = pair.indexOf('=');
      if (index <= 0) return acc;
      const key = pair.slice(0, index).trim();
      const rawValue = pair.slice(index + 1).trim();
      if (!key) return acc;
      try {
        acc[key] = decodeURIComponent(rawValue);
      } catch {
        acc[key] = rawValue;
      }
      return acc;
    }, {});
}

function isSessionModeError(err) {
  return err?.name === 'OAuthSessionModeError' || err?.code === 'invalid_state';
}

function sessionFailure(err, { operation, fallbackStatus = 400 } = {}) {
  const reason = normalizeReasonLiteral(err?.reason);
  const details = isPlainObject(err?.details) ? err.details : (isPlainObject(err?.diagnostics) ? err.diagnostics : undefined);

  let status = Number.isInteger(err?.status) ? err.status : fallbackStatus;
  if (reason === 'session_required' || reason === 'session_not_found') {
    status = 401;
  }

  const response = failure(status, status === 401 ? 'Unauthorized' : 'Invalid session mode', {
    code: 'invalid_state',
    ...(hasNonEmptyString(reason) ? { reason } : {}),
    ...(details && status < 500 ? { details } : {}),
  });

  return {
    ...response,
    _sessionReason: reason,
    _sessionOperation: operation,
  };
}

export default class AuthController {
  static __routes = [
    // Static lifecycle routes first — prevents /auth/:provider from matching these
    { method: 'GET',    path: '/auth/me',              handler: 'me' },
    { method: 'POST',   path: '/auth/signout',         handler: 'signout' },
    { method: 'GET',    path: '/auth/login/finalize',  handler: 'loginFinalize' },
    { method: 'POST',   path: '/auth/login/finalize',  handler: 'loginFinalize' },
    { method: 'GET',    path: '/auth/link/finalize',   handler: 'linkFinalize' },
    { method: 'POST',   path: '/auth/link/finalize',   handler: 'linkFinalize' },
    { method: 'POST',   path: '/auth/unlink/:provider', handler: 'unlinkProvider' },
    { method: 'DELETE', path: '/auth/unlink/:provider', handler: 'unlinkProvider' },
    // Parameterized route after static ones
    { method: 'GET',    path: '/auth/:provider',       handler: 'beginAuth' },
  ];

  constructor() {
    this.authService = null; // CDI autowired
    this.userRepository = null; // CDI autowired
    this.oauthIdentityLinkStore = null; // CDI autowired
    this.providers = {}; // set directly or by authHonoStarter()
    this.logger = null; // CDI autowired
    this.jwtSecret = null; // optional CDI property
    this.spaOrigin = null; // retained for backward compatibility
    this._revokedSessionTokens = new Map();
  }

  _jwtSecret() {
    return firstDefined(this.jwtSecret, this.authService?.jwtSecret);
  }

  _requestModeLiteral(request) {
    return firstDefined(request.query?.mode, request.body?.mode);
  }

  _requiredString(request, field, { status = 400 } = {}) {
    const value = firstDefined(request.query?.[field], request.body?.[field], request.params?.[field]);
    if (!hasNonEmptyString(value)) {
      return {
        error: failure(status, `Missing required field: ${field}`),
        value: null,
      };
    }
    return { value: value.trim() };
  }

  _provider(provider) {
    const instance = this.providers?.[provider];
    if (!instance) {
      return {
        error: failure(400, `Unknown provider: ${provider}`, {
          code: 'invalid_state',
          reason: 'unsupported_provider',
        }),
      };
    }
    return { instance };
  }

  _extractTokens(request) {
    const honoReq = request.honoCtx?.req;
    const authHeader = honoReq?.header?.('Authorization') ?? '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const cookieHeader = honoReq?.header?.('Cookie') ?? '';
    const cookies = parseCookieHeader(cookieHeader);
    const cookieToken = AUTH_SESSION_COOKIE_ALIASES
      .map((name) => cookies[name])
      .find((value) => hasNonEmptyString(value)) ?? null;

    return {
      bearerToken: hasNonEmptyString(bearerToken) ? bearerToken : null,
      cookieToken: hasNonEmptyString(cookieToken) ? cookieToken : null,
    };
  }

  _setSessionCookie(request, token) {
    request.honoCtx?.header?.(
      'Set-Cookie',
      `${AUTH_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
      { append: true },
    );
  }

  _clearSessionCookie(request) {
    request.honoCtx?.header?.(
      'Set-Cookie',
      `${AUTH_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      { append: true },
    );
  }

  _pruneRevokedSessionTokens() {
    const now = Date.now();
    for (const [token, expiresAt] of this._revokedSessionTokens.entries()) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this._revokedSessionTokens.delete(token);
      }
    }
  }

  _revokeSessionToken(token, payload) {
    const fallbackExpiryMs = Date.now() + (12 * 60 * 60 * 1000);
    const expClaim = Number(payload?.exp);
    const expiryMs = Number.isFinite(expClaim) && expClaim > 0 ? expClaim * 1000 : fallbackExpiryMs;
    this._revokedSessionTokens.set(token, expiryMs);
  }

  async _verifySessionToken({ token, mode, operation }) {
    this._pruneRevokedSessionTokens();
    if (this._revokedSessionTokens.has(token)) {
      this.logger?.info?.(`[AuthController] ${operation} revoked session token mode=${mode}`);
      return failure(401, 'Unauthorized', {
        code: 'invalid_state',
        reason: 'session_not_found',
      });
    }

    const secret = this._jwtSecret();
    if (!hasSecretValue(secret)) {
      this.logger?.error?.(`[AuthController] ${operation} missing jwt secret`);
      return failure(500, 'Authentication failed');
    }

    let payload;
    try {
      payload = await JwtSession.verify(token, secret);
    } catch (err) {
      if (err instanceof IdleExpiredError) {
        this.logger?.info?.(`[AuthController] ${operation} session expired mode=${mode} reason=idle`);
        return failure(401, 'Session expired', { reason: 'idle' });
      }

      if (err instanceof HardExpiredError) {
        this.logger?.info?.(`[AuthController] ${operation} session expired mode=${mode} reason=hard`);
        return failure(401, 'Session expired', { reason: 'hard' });
      }

      this.logger?.debug?.(`[AuthController] ${operation} invalid token mode=${mode}: ${err?.message ?? err}`);
      return failure(401, 'Unauthorized');
    }

    return { payload };
  }

  async _applyRollingRefresh({ request, payload, mode, operation }) {
    if (!JwtSession.needsRefresh(payload)) return;

    try {
      const secret = this._jwtSecret();
      const freshToken = await JwtSession.refresh(payload, secret);
      if (mode === 'bearer') {
        request.honoCtx?.header?.('X-Auth-Token', freshToken);
      } else {
        this._setSessionCookie(request, freshToken);
      }
      this.logger?.debug?.(`[AuthController] ${operation} rolling refresh mode=${mode}`);
    } catch (err) {
      this.logger?.debug?.(`[AuthController] ${operation} rolling refresh failed mode=${mode}: ${err?.message ?? err}`);
    }
  }

  async _resolveSession(request, { operation }) {
    const { bearerToken, cookieToken } = this._extractTokens(request);
    const modeLiteral = this._requestModeLiteral(request);

    let resolved;
    try {
      resolved = resolveSessionMode({
        explicitMode: modeLiteral,
        queryMode: request.query?.mode,
        bodyMode: request.body?.mode,
        bearerToken,
        cookieToken,
      });
    } catch (err) {
      if (isSessionModeError(err)) {
        const typed = sessionFailure(err, { operation });
        this.logger?.warn?.(`[AuthController] ${operation} session-resolution failed reason=${typed._sessionReason ?? 'n/a'}`);
        return typed;
      }

      this.logger?.error?.(`[AuthController] ${operation} unexpected session-resolution error: ${err?.message ?? err}`);
      return failure(500, 'Authentication failed');
    }

    const token = resolved.mode === 'bearer' ? bearerToken : cookieToken;
    const verified = await this._verifySessionToken({ token, mode: resolved.mode, operation });
    if (verified?.statusCode) {
      return verified;
    }

    await this._applyRollingRefresh({
      request,
      payload: verified.payload,
      mode: resolved.mode,
      operation,
    });

    return {
      session: {
        mode: resolved.mode,
        source: resolved.source,
        explicitMode: resolved.explicit,
        token,
      },
      payload: verified.payload,
    };
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
      const code = oauthCodeFromError(err);
      if (hasNonEmptyString(code) && KNOWN_OAUTH_CODES.has(code)) {
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

  _sessionModeForFinalize(request, operation) {
    const modeLiteral = this._requestModeLiteral(request);

    if (modeLiteral === undefined || modeLiteral === null) {
      throw createSessionModeError(
        'session_required',
        `Session mode is required for ${operation}.`,
        { operation, field: 'mode' },
      );
    }

    const mode = normalizeSessionModeLiteral(modeLiteral);
    const source = request.query?.mode !== undefined ? 'query' : 'body';

    return {
      mode,
      source,
      explicitMode: true,
    };
  }

  /**
   * GET /auth/me
   */
  async me(request) {
    const resolved = await this._resolveSession(request, { operation: 'me' });
    if (resolved?.statusCode) return resolved;

    const user = resolved.payload;
    return {
      userId: user.sub,
      email: user.email ?? null,
      providers: user.providers ?? [],
      mode: resolved.session.mode,
    };
  }

  /**
   * POST|GET /auth/login/finalize
   */
  async loginFinalize(request) {
    const providerInput = this._requiredString(request, 'provider');
    if (providerInput.error) return providerInput.error;

    const { instance, error: providerErr } = this._provider(providerInput.value);
    if (providerErr) return providerErr;

    const codeInput = this._requiredString(request, 'code');
    if (codeInput.error) return codeInput.error;

    const stateInput = this._requiredString(request, 'state');
    if (stateInput.error) return stateInput.error;

    let session;
    try {
      session = this._sessionModeForFinalize(request, 'login_finalize');
    } catch (err) {
      if (isSessionModeError(err)) {
        const typed = sessionFailure(err, { operation: 'login_finalize' });
        this.logger?.warn?.(`[AuthController] login_finalize session-mode failed reason=${typed._sessionReason ?? 'n/a'}`);
        return typed;
      }
      this.logger?.error?.(`[AuthController] login_finalize session-mode error: ${err?.message ?? err}`);
      return failure(500, 'Authentication failed');
    }

    try {
      const result = await this.authService.completeAuth(
        providerInput.value,
        instance,
        codeInput.value,
        stateInput.value,
        { session },
      );

      if (!hasNonEmptyString(result?.token)) {
        this.logger?.error?.(`[AuthController] loginFinalize missing token provider=${providerInput.value}`);
        return failure(500, 'Authentication failed');
      }

      this.logger?.info?.(`[AuthController] loginFinalize provider=${providerInput.value} mode=${session.mode} userId=${result?.user?.userId ?? 'unknown'}`);

      if (session.mode === 'cookie') {
        this._setSessionCookie(request, result.token);
        return {
          user: result.user,
          mode: session.mode,
          session,
        };
      }

      return {
        token: result.token,
        user: result.user,
        mode: session.mode,
        session,
      };
    } catch (err) {
      if (err instanceof InvalidStateError) {
        return failure(400, err.message, {
          code: 'invalid_state',
          reason: 'unknown_state',
        });
      }

      if (hasNonEmptyString(oauthCodeFromError(err))) {
        this.logger?.warn?.(`[AuthController] loginFinalize typed failure provider=${providerInput.value} mode=${session.mode} code=${oauthCodeFromError(err)} reason=${normalizeReasonLiteral(oauthReasonFromError(err)) ?? 'n/a'}`);
        return oauthFailure(err, { fallbackMessage: 'Authentication failed' });
      }

      this.logger?.error?.(`[AuthController] loginFinalize error provider=${providerInput.value} mode=${session.mode}: ${err?.message ?? err}`);
      return failure(500, 'Authentication failed');
    }
  }

  /**
   * POST|GET /auth/link/finalize
   */
  async linkFinalize(request) {
    const resolved = await this._resolveSession(request, { operation: 'link_finalize' });
    if (resolved?.statusCode) return resolved;

    const providerInput = this._requiredString(request, 'provider');
    if (providerInput.error) return providerInput.error;

    const { instance, error: providerErr } = this._provider(providerInput.value);
    if (providerErr) return providerErr;

    const store = this._requireIdentityStore();
    if (!store) return failure(500, 'Provider link failed');

    const codeInput = this._requiredString(request, 'code');
    if (codeInput.error) return codeInput.error;

    const stateInput = this._requiredString(request, 'state');
    if (stateInput.error) return stateInput.error;

    const storedStateInput = this._requiredString(request, 'stored_state');
    if (storedStateInput.error) return storedStateInput.error;

    if (stateInput.value !== storedStateInput.value) {
      return failure(400, 'OAuth state mismatch', {
        code: 'invalid_state',
        reason: 'state_mismatch',
      });
    }

    const codeVerifier = firstDefined(request.query?.code_verifier, request.body?.code_verifier, '');

    let callbackResult;
    try {
      callbackResult = await instance.validateCallback(codeInput.value, codeVerifier ?? '');
    } catch (err) {
      this.logger?.error?.(`[AuthController] linkFinalize callback failed provider=${providerInput.value} mode=${resolved.session.mode}: ${err?.message ?? err}`);
      return failure(500, 'Provider callback failed');
    }

    if (!isPlainObject(callbackResult) || !hasNonEmptyString(callbackResult.providerUserId)) {
      this.logger?.error?.(`[AuthController] linkFinalize callback returned malformed payload provider=${providerInput.value} mode=${resolved.session.mode}`);
      return failure(400, 'Provider callback failed', {
        code: 'invalid_state',
        reason: 'malformed_provider_callback',
      });
    }

    const providerUserId = callbackResult.providerUserId.trim();
    const userId = resolved.payload.sub;

    try {
      await store.link({
        userId,
        provider: providerInput.value,
        providerUserId,
      });
    } catch (err) {
      this.logger?.warn?.(`[AuthController] linkFinalize store.link failed userId=${userId} provider=${providerInput.value} mode=${resolved.session.mode}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider link failed' });
    }

    let links;
    try {
      links = await this._readLinksFromStore(store, userId, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] linkFinalize getLinksForUser failed userId=${userId} mode=${resolved.session.mode}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider link failed' });
    }

    const updatedUser = await this._syncProvidersProjection(userId, links);
    if (!updatedUser) {
      return failure(500, 'Provider link failed');
    }

    this.logger?.info?.(`[AuthController] linkFinalize userId=${userId} provider=${providerInput.value} mode=${resolved.session.mode}`);
    return {
      user: updatedUser,
      mode: resolved.session.mode,
    };
  }

  /**
   * POST|DELETE /auth/unlink/:provider
   */
  async unlinkProvider(request) {
    const resolved = await this._resolveSession(request, { operation: 'unlink' });
    if (resolved?.statusCode) return resolved;

    const { provider } = request.params;
    const { error: providerErr } = this._provider(provider);
    if (providerErr) return providerErr;

    const store = this._requireIdentityStore();
    if (!store) return failure(500, 'Provider unlink failed');

    const userId = resolved.payload.sub;

    let existingLinks;
    try {
      existingLinks = await this._readLinksFromStore(store, userId, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlink getLinksForUser failed userId=${userId} mode=${resolved.session.mode}: ${err?.message ?? err}`);
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
        reason: 'last_provider_lockout',
      });
    }

    try {
      await store.unlink({
        userId,
        provider,
        providerUserId: current.providerUserId,
      });
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlink store.unlink failed userId=${userId} provider=${provider} mode=${resolved.session.mode}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider unlink failed' });
    }

    let links;
    try {
      links = await this._readLinksFromStore(store, userId, 'getLinksForUser');
    } catch (err) {
      this.logger?.warn?.(`[AuthController] unlink post-unlink getLinksForUser failed userId=${userId} mode=${resolved.session.mode}: ${err?.message ?? err}`);
      return oauthFailure(err, { fallbackMessage: 'Provider unlink failed' });
    }

    const updatedUser = await this._syncProvidersProjection(userId, links);
    if (!updatedUser) {
      return failure(500, 'Provider unlink failed');
    }

    this.logger?.info?.(`[AuthController] unlink userId=${userId} provider=${provider} mode=${resolved.session.mode}`);
    return {
      providers: updatedUser.providers,
      mode: resolved.session.mode,
    };
  }

  /**
   * POST /auth/signout
   */
  async signout(request) {
    const resolved = await this._resolveSession(request, { operation: 'signout' });
    if (resolved?.statusCode) return resolved;

    this._revokeSessionToken(resolved.session.token, resolved.payload);

    if (resolved.session.mode === 'cookie') {
      this._clearSessionCookie(request);
    }

    this.logger?.info?.(`[AuthController] signout userId=${resolved.payload.sub ?? 'unknown'} mode=${resolved.session.mode}`);

    return {
      signedOut: true,
      mode: resolved.session.mode,
      message: resolved.session.mode === 'cookie'
        ? 'Session cookie cleared.'
        : 'Bearer session is stateless; discard the token client-side.',
    };
  }

  /**
   * GET /auth/:provider
   * Initiates OAuth flow. Returns { authorizationURL, state }.
   */
  beginAuth(request) {
    const { provider } = request.params;
    const { instance, error: providerErr } = this._provider(provider);
    if (providerErr) return providerErr;

    const options = {};
    if (request.query?.link === 'true') options.link = true;

    const result = this.authService.beginAuth(provider, instance, options);
    this.logger?.debug?.(`[AuthController] beginAuth provider=${provider} link=${!!options.link}`);
    return result;
  }
}
