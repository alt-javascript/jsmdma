/**
 * AuthService.js — Orchestrates OAuth flows and user identity management.
 *
 * Responsibilities:
 *   1. Generate OAuth authorization URL + state/codeVerifier
 *   2. Validate OAuth callback state and exchange callback code
 *   3. Resolve ownership through oauthIdentityLinkStore authority
 *   4. Persist/sync user profile projection in UserRepository
 *   5. Issue signed JWT session token
 */
import { generateState, generateCodeVerifier } from 'arctic';
import { JwtSession, InvalidStateError } from '@alt-javascript/jsmdma-auth-core';

const OAUTH_ERROR_CODES = Object.freeze({
  INVALID_STATE: 'invalid_state',
  INTERNAL_ERROR: 'internal_error',
  IDENTITY_LINK_CONFLICT: 'identity_link_conflict',
});

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function oauthReasonFromError(err) {
  return firstDefined(err?.reason, err?.diagnostics?.reason);
}

function oauthCodeFromError(err) {
  return firstDefined(err?.code, err?.errorCode);
}

function inferStatusForCode(code) {
  if (code === OAUTH_ERROR_CODES.IDENTITY_LINK_CONFLICT) return 409;
  if (code === OAUTH_ERROR_CODES.INVALID_STATE) return 500;
  if (code === OAUTH_ERROR_CODES.INTERNAL_ERROR) return 500;
  return 500;
}

function createTypedOauthError({ code, reason, message, details, cause, status }) {
  const err = new Error(message);
  err.name = 'OAuthIdentityError';
  err.code = code;
  err.reason = reason;
  err.status = Number.isInteger(status) ? status : inferStatusForCode(code);

  if (details !== undefined) {
    err.details = details;
    err.diagnostics = {
      reason,
      ...isPlainObject(details) ? details : { detail: details },
    };
  } else {
    err.diagnostics = { reason };
  }

  if (cause !== undefined) {
    err.cause = cause;
  }

  return err;
}

function normalizeStoreError(operation, err) {
  const existingCode = oauthCodeFromError(err);
  if (hasNonEmptyString(existingCode)) {
    return err;
  }

  const message = hasNonEmptyString(err?.message) ? err.message : String(err ?? 'Unknown error');
  const looksLikeTimeout = /timeout/i.test(message) || err?.code === 'ETIMEDOUT';

  return createTypedOauthError({
    code: OAUTH_ERROR_CODES.INVALID_STATE,
    reason: looksLikeTimeout ? 'dependency_timeout' : 'malformed_dependency_response',
    message: `OAuth identity store ${operation} failed: ${message}`,
    details: { operation },
    cause: err,
  });
}

function normalizeProjectionLinks(links, operation) {
  if (!Array.isArray(links)) {
    throw createTypedOauthError({
      code: OAUTH_ERROR_CODES.INVALID_STATE,
      reason: 'malformed_dependency_response',
      message: `OAuth identity store ${operation} returned malformed links payload.`,
      details: { operation },
    });
  }

  const normalized = links.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'malformed_dependency_response',
        message: `OAuth identity store ${operation} returned malformed link entry at index ${index}.`,
        details: { operation, index },
      });
    }

    const provider = hasNonEmptyString(entry.provider) ? entry.provider.trim() : null;
    const providerUserId = hasNonEmptyString(entry.providerUserId) ? entry.providerUserId.trim() : null;

    if (!provider || !providerUserId) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'malformed_dependency_response',
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
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'invalid_projection_state',
        message: 'OAuth identity link projection returned duplicate provider entries.',
        details: { operation },
      });
    }
    seenProviders.add(entry.provider);
  }

  return normalized;
}

export default class AuthService {
  constructor() {
    this.userRepository = null; // CDI autowired
    this.oauthIdentityLinkStore = null; // CDI autowired
    this.jwtSecret = null; // CDI autowired
    this.logger = null; // CDI autowired
    this.uuidGenerator = () => globalThis.crypto.randomUUID();
    this._pendingAuth = new Map(); // state → { codeVerifier, expiry }
  }

  _requireStore() {
    const store = this.oauthIdentityLinkStore;
    if (
      !store
      || typeof store.getUserByProviderAnchor !== 'function'
      || typeof store.link !== 'function'
      || typeof store.getLinksForUser !== 'function'
    ) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INTERNAL_ERROR,
        reason: 'identity_store_unavailable',
        message: 'OAuth identity link store dependency is not configured correctly.',
      });
    }
    return store;
  }

  /**
   * Generate the OAuth authorization URL.
   * Stores codeVerifier server-side — it is NOT returned to the browser.
   *
   * @returns {{ authorizationURL: string, state: string }}
   */
  beginAuth(providerName, providerInstance, options = {}) {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = providerInstance.createAuthorizationURL(state, codeVerifier);

    // BFF: keep codeVerifier server-side; expires in 10 minutes
    const pending = { codeVerifier, expiry: Date.now() + 10 * 60 * 1000 };
    if (options.link) pending.linkMode = true;
    this._pendingAuth.set(state, pending);

    this.logger?.debug?.(`[AuthService] beginAuth provider=${providerName} state=${state.slice(0, 8)}... link=${!!options.link}`);

    return { authorizationURL: url.toString(), state };
  }

  async _lookupUserIdByAnchor(providerName, providerUserId) {
    let ownedUserId;

    try {
      ownedUserId = await this._requireStore().getUserByProviderAnchor({
        provider: providerName,
        providerUserId,
      });
    } catch (err) {
      throw normalizeStoreError('getUserByProviderAnchor', err);
    }

    if (ownedUserId == null) return null;

    if (!hasNonEmptyString(ownedUserId)) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'malformed_dependency_response',
        message: 'OAuth identity store returned a non-string userId for provider anchor lookup.',
        details: { operation: 'getUserByProviderAnchor' },
      });
    }

    return ownedUserId;
  }

  async _loadUser(userId, contextOperation) {
    const user = await this.userRepository.getUser(userId);

    if (!user) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'profile_not_found_for_anchor',
        message: 'OAuth provider anchor resolves to a missing user profile.',
        details: { operation: contextOperation, userId },
      });
    }

    return user;
  }

  async _syncProvidersProjection(userId) {
    let links;

    try {
      links = await this._requireStore().getLinksForUser(userId);
    } catch (err) {
      throw normalizeStoreError('getLinksForUser', err);
    }

    const normalizedLinks = normalizeProjectionLinks(links, 'getLinksForUser');

    let user;
    try {
      user = await this.userRepository.syncProvidersProjection(userId, normalizedLinks);
    } catch (err) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INTERNAL_ERROR,
        reason: 'profile_projection_sync_failed',
        message: `Failed to synchronize user provider projection for userId=${userId}.`,
        details: { operation: 'syncProvidersProjection', userId },
        cause: err,
      });
    }

    return {
      user,
      providerNames: normalizedLinks.map((entry) => entry.provider),
    };
  }

  async _safeDeleteUser(userId, context) {
    try {
      await this.userRepository.deleteUser(userId);
    } catch (cleanupErr) {
      this.logger?.error?.(`[AuthService] cleanup failed userId=${userId} context=${context}: ${cleanupErr?.message ?? cleanupErr}`);
    }
  }

  async _createAndLinkFirstLogin(providerName, providerUserId, callbackEmail) {
    const userId = this.uuidGenerator();
    let createdUser;

    try {
      createdUser = await this.userRepository.create(userId, callbackEmail, []);
    } catch (err) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INTERNAL_ERROR,
        reason: 'profile_create_failed',
        message: `Failed to create user profile for first login userId=${userId}.`,
        details: { operation: 'create', userId },
        cause: err,
      });
    }

    try {
      await this._requireStore().link({
        userId: createdUser.userId,
        provider: providerName,
        providerUserId,
      });
      return createdUser;
    } catch (rawErr) {
      const linkErr = normalizeStoreError('link', rawErr);
      await this._safeDeleteUser(createdUser.userId, 'link_failure_after_profile_create');

      if (oauthCodeFromError(linkErr) === OAUTH_ERROR_CODES.IDENTITY_LINK_CONFLICT) {
        const racedOwnerId = await this._lookupUserIdByAnchor(providerName, providerUserId);

        if (!hasNonEmptyString(racedOwnerId)) {
          throw createTypedOauthError({
            code: OAUTH_ERROR_CODES.IDENTITY_LINK_CONFLICT,
            reason: 'ambiguous_anchor_owner',
            message: 'Provider anchor conflict detected but no deterministic owner could be resolved.',
            details: {
              operation: 'link',
              provider: providerName,
              providerUserId,
              upstreamReason: oauthReasonFromError(linkErr),
            },
            cause: linkErr,
            status: 409,
          });
        }

        return this._hydrateReturningUser(racedOwnerId, callbackEmail);
      }

      throw linkErr;
    }
  }

  async _hydrateReturningUser(userId, callbackEmail) {
    const user = await this._loadUser(userId, 'anchor_lookup');

    if (hasNonEmptyString(callbackEmail) && !hasNonEmptyString(user.email)) {
      try {
        await this.userRepository.updateEmail(userId, callbackEmail);
      } catch (err) {
        throw createTypedOauthError({
          code: OAUTH_ERROR_CODES.INTERNAL_ERROR,
          reason: 'profile_update_failed',
          message: `Failed to persist callback email for userId=${userId}.`,
          details: { operation: 'updateEmail', userId },
          cause: err,
        });
      }

      return this._loadUser(userId, 'email_refresh');
    }

    return user;
  }

  /**
   * Complete an OAuth callback: validate state, exchange code, resolve user,
   * issue JWT.
   *
   * @param {string} providerName
   * @param {Object} providerInstance
   * @param {string} code
   * @param {string} state
   * @returns {Promise<{ user: Object, token: string }>} 
   * @throws {InvalidStateError} if state is unknown, expired, or already consumed
   */
  async completeAuth(providerName, providerInstance, code, state) {
    const pending = this._pendingAuth.get(state);
    if (!pending || Date.now() > pending.expiry) {
      this._pendingAuth.delete(state);
      this.logger?.warn?.(`[AuthService] unknown/expired state provider=${providerName}`);
      throw new InvalidStateError(`Unknown or expired OAuth state for provider ${providerName}`);
    }
    const { codeVerifier, linkMode } = pending;
    this._pendingAuth.delete(state); // one-time use

    // Link mode: pass the code back to the SPA instead of exchanging it here.
    // The SPA will call POST /auth/link/:provider with the code.
    if (linkMode) {
      this.logger?.debug?.('[AuthService] completeAuth linkMode — forwarding code to SPA');
      return { linkMode: true, code, state, codeVerifier };
    }

    const callbackResult = await providerInstance.validateCallback(code, codeVerifier);

    if (!isPlainObject(callbackResult) || !hasNonEmptyString(callbackResult.providerUserId)) {
      throw createTypedOauthError({
        code: OAUTH_ERROR_CODES.INVALID_STATE,
        reason: 'malformed_provider_callback',
        message: `OAuth callback payload for provider ${providerName} is malformed.`,
        details: { provider: providerName },
      });
    }

    const providerUserId = callbackResult.providerUserId.trim();
    const callbackEmail = hasNonEmptyString(callbackResult.email) ? callbackResult.email.trim() : null;

    const ownedUserId = await this._lookupUserIdByAnchor(providerName, providerUserId);
    const isNew = ownedUserId == null;

    let user;
    if (isNew) {
      user = await this._createAndLinkFirstLogin(providerName, providerUserId, callbackEmail);
    } else {
      user = await this._hydrateReturningUser(ownedUserId, callbackEmail);
    }

    const synced = await this._syncProvidersProjection(user.userId);

    const token = await JwtSession.sign(
      {
        sub: synced.user.userId,
        providers: synced.providerNames,
        email: synced.user.email ?? null,
      },
      this.jwtSecret,
    );

    this.logger?.info?.(`[AuthService] completeAuth provider=${providerName} userId=${synced.user.userId} new=${isNew}`);

    return { user: synced.user, token };
  }
}
