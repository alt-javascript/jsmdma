/**
 * errors.js — Typed error classes for jsmdma auth
 *
 * Using typed errors allows callers to distinguish between:
 *   - Invalid/tampered tokens
 *   - Session idle timeout (re-auth required)
 *   - Session hard timeout (force re-auth regardless of activity)
 *   - OAuth state mismatch (CSRF protection)
 *   - Provider-level failures
 */

/**
 * Thrown when a JWT cannot be decoded or has an invalid signature.
 */
export class InvalidTokenError extends Error {
  constructor(message = 'Invalid token') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Thrown when a JWT's iat is older than the idle TTL (3 days).
 * The user needs to re-authenticate.
 */
export class IdleExpiredError extends Error {
  constructor(message = 'Session idle timeout exceeded') {
    super(message);
    this.name = 'IdleExpiredError';
  }
}

/**
 * Thrown when a JWT's iat_session is older than the hard TTL (7 days).
 * The user must re-authenticate regardless of recent activity.
 */
export class HardExpiredError extends Error {
  constructor(message = 'Session hard timeout exceeded') {
    super(message);
    this.name = 'HardExpiredError';
  }
}

/**
 * Thrown when the OAuth state parameter does not match the stored state.
 * This indicates a possible CSRF attack.
 */
export class InvalidStateError extends Error {
  constructor(message = 'OAuth state mismatch') {
    super(message);
    this.name = 'InvalidStateError';
  }
}

/**
 * Thrown when an OAuth provider returns an error or unexpected response.
 * @property {string} provider — the provider name (e.g. 'google', 'github')
 */
export class ProviderError extends Error {
  constructor(provider, message) {
    super(message ?? `OAuth provider error: ${provider}`);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}
